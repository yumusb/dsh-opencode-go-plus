// @ts-check
/**
 * Recognition and repair of control-protocol text that the GO gateway
 * occasionally decodes into the assistant's ordinary text or reasoning channel.
 *
 * Observed failure shapes (all from the same gateway, all model-independent):
 *
 *   - a complete DSML tool call written as prose, so the tool never runs and
 *     the model narrates its own tool result;
 *   - a fabricated `tool_result` block: JSON the model invented, presented as
 *     if a tool had answered;
 *   - chat-template control tokens leaking as literal characters;
 *   - Qwen/GLM XML tool calls (`<tool_call>...</tool_call>`, `<function=...>`).
 *
 * Everything here is a pure string function so it can be unit-tested without a
 * network, and so the streaming layer decides *when* to call it. The rule
 * throughout is conservative: a block is only converted when it is COMPLETE,
 * bounded, and names a tool this request actually declared. Anything else is
 * returned as `null` so the caller passes the original text through untouched -
 * losing a character of a legitimate answer is worse than leaving a marker in
 * the transcript.
 *
 * IMPORTANT: every marker character is written as a JS escape (U+FF5C for the
 * fullwidth bar, U+2581 for the block glyph), never as a literal. This file must
 * stay ASCII-only: those glyphs are visually ambiguous with the ASCII pipe and
 * are corrupted by some editors and transports, which silently produces a
 * pattern that no longer matches.
 *
 * @module dsh-opencode-go-plus/dsml
 */

/** U+FF5C FULLWIDTH VERTICAL LINE, the bar DSML actually uses. */
const VBAR = "\uFF5C";
/** U+2581 LOWER ONE EIGHTH BLOCK, used inside sentence tokens. */
const BLOCK = "\u2581";

/** The vertical bar in DSML markers in either form, as regex source. */
const BAR = "(?:\\uFF5C|\\|)";

/** The DSML open marker, as regex source. */
const DSML = `<${BAR}DSML${BAR}`;

/** The DSML close marker (`</` + bar + DSML + bar), as regex source. */
const DSML_CLOSE = `</${BAR}DSML${BAR}`;

/**
 * The literal DSML marker prefixes, used by the streaming layer. The close form
 * is included so an orphaned closer (its block was already converted, or a
 * fabrication was just dropped) is consumed instead of reaching the reader.
 */
export const DSML_PREFIXES = Object.freeze([`<${VBAR}DSML${VBAR}`, `</${VBAR}DSML${VBAR}`]);

/** Largest single block we are willing to buffer or parse. */
export const MAX_BLOCK_BYTES = 32768;

/**
 * Literal chat-template tokens that must never reach the transcript.
 * @type {readonly string[]}
 */
export const CONTROL_TOKENS = Object.freeze([
	`<${VBAR}begin${BLOCK}of${BLOCK}sentence${VBAR}>`,
	`<|begin${BLOCK}of${BLOCK}sentence|>`,
	"<|begin_of_sentence|>",
	`<${VBAR}end${BLOCK}of${BLOCK}sentence${VBAR}>`,
	`<|end${BLOCK}of${BLOCK}sentence|>`,
	"<|end_of_sentence|>",
	"<|endoftext|>",
	"<|im_start|>",
	"<|im_end|>",
	"<|observation|>",
	"<|end_of_thinking|>",
	"<|start_of_thinking|>",
	"<tool_result>",
	"</tool_result>",
	"</tool>",
	"</tool_calls>",
	"</function>"
]);

/** @param {string} value */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @type {RegExp} */
const CONTROL_TOKEN_RE = new RegExp(CONTROL_TOKENS.map(escapeRegExp).join("|"), "g");

/**
 * Any residual DSML tag - a wrapper, an attribute fragment, a stray parameter
 * shard left behind by a truncated conversion.
 * @type {RegExp}
 */
const GENERIC_DSML_TAG_RE = new RegExp(`(?:${DSML}|${DSML_CLOSE})[a-zA-Z_][^<>]{0,200}>`, "g");

/** Remove literal chat-template tokens only. */
export function stripTemplateTokens(text) {
	let removed = 0;
	const stripped = String(text).replace(CONTROL_TOKEN_RE, () => {
		removed += 1;
		return "";
	});
	return { text: stripped, removed };
}

/**
 * Remove literal chat-template tokens AND residual DSML tags. Used on complete
 * text (replay, flush, final cleanup); the streaming hot path uses
 * {@link stripTemplateTokens}, because an unconverted block must reach the
 * reader verbatim.
 */
export function stripControlTokens(text) {
	const template = stripTemplateTokens(text);
	let removed = template.removed;
	const stripped = template.text.replace(GENERIC_DSML_TAG_RE, () => {
		removed += 1;
		return "";
	});
	return { text: stripped, removed };
}

/**
 * The openers that mean "a conversion may be starting here". Ordering matters:
 * the earliest match wins, and each entry doubles as a prefix for the streaming
 * hold-back check.
 * @type {readonly string[]}
 */
export const TRIGGER_OPENERS = Object.freeze([
	`<${VBAR}DSML${VBAR}invoke`,
	`<${VBAR}DSML${VBAR}tool_calls`,
	`<${VBAR}DSML${VBAR}calls`,
	`<${VBAR}DSML${VBAR}tool_call`,
	`<${VBAR}DSML${VBAR}tool_result`,
	"<tool_call>",
	"<function="
]);

/**
 * True when the text could still be the beginning of a marker (so a streaming
 * consumer must hold it back rather than emit it).
 * @param {string} candidate
 * @returns {boolean}
 */
export function isMarkerPrefix(candidate) {
	if (candidate.length === 0) return false;
	return TRIGGER_OPENERS.some((opener) => opener.startsWith(candidate))
		|| DSML_PREFIXES.some((prefix) => prefix.startsWith(candidate))
		|| CONTROL_TOKENS.some((token) => token.startsWith(candidate));
}

/**
 * Locate the earliest real call opener.
 * @param {string} text
 * @returns {{ index: number, opener: string }|null}
 */
export function findTrigger(text) {
	let best = null;
	for (const opener of TRIGGER_OPENERS) {
		const index = text.indexOf(opener);
		if (index < 0) continue;
		if (best === null || index < best.index) best = { index, opener };
	}
	return best;
}

/**
 * Locate the earliest marker of any kind, including a residual DSML tag that is
 * not one of the known call openers. The streaming layer needs this: a stray
 * shard must be consumed and dropped, while the parser only ever converts real
 * call blocks.
 * @param {string} text
 * @returns {{ index: number, opener: string }|null}
 */
export function findMarker(text) {
	let best = findTrigger(text);
	for (const prefix of DSML_PREFIXES) {
		const index = text.indexOf(prefix);
		if (index < 0) continue;
		if (best === null || index < best.index) best = { index, opener: prefix };
	}
	return best;
}

/**
 * Read a double-quoted, single-quoted, or bare attribute value.
 * @param {string} attributes
 * @param {string} name
 * @returns {string|null}
 */
function attributeValue(attributes, name) {
	const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
	if (quoted !== null) return quoted[2] ?? quoted[3] ?? "";
	const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`).exec(attributes);
	return bare === null ? null : bare[1];
}

/**
 * Parse the parameter list of one DSML invoke body.
 *
 * `string="true"` means the body is the literal string; otherwise it is JSON
 * and falls back to the raw text when it is not valid JSON. Non-whitespace text
 * left between parameters means the block is malformed, and the caller then
 * passes the whole thing through.
 * @param {string} body
 * @returns {Record<string, unknown>|null}
 */
function parseDsmlParameters(body) {
	const parameterRe = new RegExp(`${DSML}parameter\\b([^>]*)>([\\s\\S]*?)${DSML_CLOSE}parameter>`, "g");
	/** @type {Record<string, unknown>} */
	const args = {};
	/** @type {RegExpMatchArray[]} */
	const matches = [...body.matchAll(parameterRe)];
	for (const match of matches) {
		const name = attributeValue(match[1], "name");
		if (name === null || name.length === 0) return null;
		const isString = attributeValue(match[1], "string");
		const raw = match[2];
		if (isString === "true") {
			args[name] = raw;
			continue;
		}
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			args[name] = "";
			continue;
		}
		try {
			args[name] = JSON.parse(trimmed);
		} catch {
			args[name] = trimmed;
		}
	}
	if (matches.length === 0) return {};
	// Everything except parameters must be whitespace; a truncated parameter
	// (the failure mode that produced isolated parameter shards) lands here.
	let residue = "";
	let cursor = 0;
	for (const match of matches) {
		residue += body.slice(cursor, match.index);
		cursor = match.index + match[0].length;
	}
	residue += body.slice(cursor);
	if (residue.trim().length > 0) return null;
	return args;
}

/**
 * One parsed tool call.
 * @typedef {{ name: string, argumentsJson: string, source: string }} ParsedCall
 */

/** A parse attempt either completes, needs more input, or is not a call. */
const INCOMPLETE = Object.freeze({ status: "incomplete" });
const INVALID = Object.freeze({ status: "invalid" });

/**
 * Parse a DSML invoke block starting at `opener`.
 * @param {string} text
 * @param {number} opener
 * @returns {{ status: "complete", calls: ParsedCall[], end: number }|{ status: "incomplete" }|{ status: "invalid" }}
 */
function parseDsmlInvoke(text, opener) {
	const openRe = new RegExp(`^${DSML}invoke\\b([^>]*)>`);
	const head = openRe.exec(text.slice(opener));
	if (head === null) return INCOMPLETE;
	const name = attributeValue(head[1], "name");
	if (name === null || name.trim().length === 0) return INVALID;
	const bodyStart = opener + head[0].length;
	const closerRe = new RegExp(`${DSML_CLOSE}invoke>`);
	const closeMatch = closerRe.exec(text.slice(bodyStart));
	if (closeMatch === null) return INCOMPLETE;
	const body = text.slice(bodyStart, bodyStart + closeMatch.index);
	if (body.length > MAX_BLOCK_BYTES) return INVALID;
	const args = parseDsmlParameters(body);
	if (args === null) return INVALID;
	const end = bodyStart + closeMatch.index + closeMatch[0].length;
	return {
		status: "complete",
		calls: [{ name: name.trim(), argumentsJson: JSON.stringify(args), source: text.slice(opener, end) }],
		end
	};
}

/**
 * Parse `<tool_call>...</tool_call>` (Qwen JSON form, Qwen name/parameters form,
 * or GLM `<name>/<parameters>` form).
 * @param {string} text
 * @param {number} opener
 * @returns {{ status: "complete", calls: ParsedCall[], end: number }|{ status: "incomplete" }|{ status: "invalid" }}
 */
function parseXmlToolCall(text, opener) {
	const open = "<tool_call>";
	const close = "</tool_call>";
	const bodyStart = opener + open.length;
	const closeAt = text.indexOf(close, bodyStart);
	if (closeAt < 0) return INCOMPLETE;
	const body = text.slice(bodyStart, closeAt);
	if (body.length > MAX_BLOCK_BYTES) return INVALID;
	const end = closeAt + close.length;

	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			const name = typeof parsed?.name === "string" ? parsed.name : undefined;
			if (name === undefined) return INVALID;
			const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
			return {
				status: "complete",
				calls: [{ name, argumentsJson: JSON.stringify(rawArgs), source: text.slice(opener, end) }],
				end
			};
		} catch {
			// fall through to the XML form below
		}
	}
	const nameMatch = /<name>\s*([^<]*?)\s*<\/name>/.exec(body);
	if (nameMatch === null) return INVALID;
	const parametersMatch = /<parameters>\s*([\s\S]*?)\s*<\/parameters>/.exec(body);
	let args = {};
	if (parametersMatch !== null) {
		try {
			args = JSON.parse(parametersMatch[1]);
		} catch {
			return INVALID;
		}
	}
	return {
		status: "complete",
		calls: [{ name: nameMatch[1], argumentsJson: JSON.stringify(args), source: text.slice(opener, end) }],
		end
	};
}

/**
 * Parse `<function=name>...</function>` (Qwen XML variant) with
 * `<parameter=key>value</parameter>` children.
 * @param {string} text
 * @param {number} opener
 * @returns {{ status: "complete", calls: ParsedCall[], end: number }|{ status: "incomplete" }|{ status: "invalid" }}
 */
function parseXmlFunction(text, opener) {
	const head = /^<function=([^>\s]+)>/.exec(text.slice(opener));
	if (head === null) return INCOMPLETE;
	const bodyStart = opener + head[0].length;
	const closeAt = text.indexOf("</function>", bodyStart);
	if (closeAt < 0) return INCOMPLETE;
	const body = text.slice(bodyStart, closeAt);
	if (body.length > MAX_BLOCK_BYTES) return INVALID;
	/** @type {Record<string, unknown>} */
	const args = {};
	const parameterRe = /<parameter(?:=([^>\s]+)|\s+name\s*=\s*"([^"]*)")>([\s\S]*?)<\/parameter>/g;
	/** @type {RegExpMatchArray[]} */
	const matches = [...body.matchAll(parameterRe)];
	for (const match of matches) {

		const name = match[1] ?? match[2] ?? "";
		if (name.length === 0) return INVALID;
		args[name] = match[3];
	}
	if (matches.length > 0) {
		let residue = "";
		let cursor = 0;
		for (const match of matches) {
			residue += body.slice(cursor, match.index);
			cursor = match.index + match[0].length;
		}
		residue += body.slice(cursor);
		if (residue.trim().length > 0) return INVALID;
	}
	const end = closeAt + "</function>".length;
	return {
		status: "complete",
		calls: [{ name: head[1], argumentsJson: JSON.stringify(args), source: text.slice(opener, end) }],
		end
	};
}

/** @param {string} opener */
function isWrapperOpener(opener) {
	return opener.endsWith("tool_calls") || opener.endsWith("calls") || opener.endsWith("tool_call");
}

/**
 * Parse every tool call in a text fragment.
 *
 * Returns `null` - meaning "do not convert anything" - when the text contains a
 * trigger that does not resolve into at least one valid call. This is the whole
 * safety gate: a single unparseable or truncated marker preserves the original
 * bytes instead of half-converting a turn.
 * @param {string} text
 * @param {{ toolNames?: ReadonlySet<string> }} [options]
 * @returns {{ calls: ParsedCall[], ranges: Array<[number, number]> }|null}
 */
export function parseToolCalls(text, options = {}) {
	const toolNames = options.toolNames;
	if (typeof text !== "string" || text.length === 0) return null;
	if (text.length > MAX_BLOCK_BYTES * 8) return null;

	/** @type {ParsedCall[]} */
	const calls = [];
	/** @type {Array<[number, number]>} */
	const ranges = [];

	let index = 0;
	while (index < text.length) {
		const trigger = findTrigger(text.slice(index));
		if (trigger === null) break;
		const at = index + trigger.index;
		const opener = trigger.opener;
		let result;
		if (opener.endsWith("invoke")) result = parseDsmlInvoke(text, at);
		else if (opener === "<tool_call>") result = parseXmlToolCall(text, at);
		else if (opener === "<function=") result = parseXmlFunction(text, at);
		else if (isWrapperOpener(opener)) {
			// A wrapper carries no call of its own; the invokes inside it are
			// found by the next iteration, and the wrapper tag itself is cut as
			// residue so no markup reaches the reader.
			const tagEnd = text.indexOf(">", at);
			if (tagEnd < 0) return null;
			ranges.push([at, tagEnd + 1]);
			index = tagEnd + 1;
			continue;
		} else {
			return null;
		}

		if (result.status !== "complete") return null;
		calls.push(...result.calls);
		ranges.push([at, result.end]);
		index = result.end;
	}

	if (calls.length === 0) return null;
	if (toolNames !== undefined) {
		for (const call of calls) {
			if (!toolNames.has(call.name)) return null;
		}
	}
	// Stray shards and closing tags around the converted calls are residue too.
	for (const match of text.matchAll(GENERIC_DSML_TAG_RE)) {
		const start = match.index;
		if (ranges.some(([from, to]) => start >= from && start < to)) continue;
		ranges.push([start, start + match[0].length]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	return { calls, ranges };
}

/**
 * Remove `[start, end)` ranges and report how much was cut.
 * @param {string} text
 * @param {Array<[number, number]>} ranges
 * @returns {{ text: string, removed: number }}
 */
export function cutRanges(text, ranges) {
	if (ranges.length === 0) return { text, removed: 0 };
	let out = "";
	let cursor = 0;
	let removed = 0;
	for (const [start, end] of ranges) {
		if (start < cursor) continue;
		out += text.slice(cursor, start);
		removed += end - start;
		cursor = end;
	}
	out += text.slice(cursor);
	return { text: out, removed };
}

/**
 * The replacement that marks an intercepted fabrication in the transcript:
 * "(intercepted: the model fabricated this tool result)".
 */
export const FABRICATED_RESULT_NOTE = "(\u5DF2\u622A\u83B7\u6A21\u578B\u4F2A\u9020\u7684\u5DE5\u5177\u7ED3\u679C)";

/**
 * Scan a JSON object/array literal starting at `start` (which must be `{` or
 * `[`), honoring strings and escapes. Returns the index just past it, or -1.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function scanJsonLiteral(text, start) {
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") inString = true;
		else if (char === open) depth += 1;
		else if (char === close) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/**
 * Replace fabricated tool results with a visible note.
 *
 * A fabricated result is a `tool_result` marker the model wrote itself; it must
 * never be treated as a real tool answer (and must never become a tool call).
 * When its JSON payload cannot be delimited the block is dropped up to a closing
 * marker, or to the end of the text when none exists.
 * @param {string} text
 * @returns {{ text: string, removed: number }}
 */
export function neutralizeFabricatedResults(text) {
	if (typeof text !== "string" || text.length === 0) return { text, removed: 0, complete: true };
	const openRe = new RegExp(`${DSML}tool_result\\b[^>]*>`, "g");
	let removed = 0;
	let complete = true;
	let out = "";
	let cursor = 0;
	for (const match of text.matchAll(openRe)) {
		const start = match.index;
		if (start < cursor) continue;
		const bodyStart = start + match[0].length;
		let end = -1;
		const closeRe = new RegExp(`${DSML_CLOSE}tool_result>`, "g");
		closeRe.lastIndex = bodyStart;
		const closeMatch = closeRe.exec(text);
		let payloadEnd = bodyStart;
		while (payloadEnd < text.length && /\s/.test(text[payloadEnd])) payloadEnd += 1;
		if (text[payloadEnd] === "{" || text[payloadEnd] === "[") {
			const scanned = scanJsonLiteral(text, payloadEnd);
			if (scanned > 0) end = scanned;
		}
		if (closeMatch !== null && (end < 0 || closeMatch.index < end)) end = closeMatch.index + closeMatch[0].length;
		if (end < 0) {
			// The payload is still arriving: the caller must wait rather than
			// delete the remainder of a block that is not finished.
			complete = false;
			end = text.length;
		}
		out += text.slice(cursor, start) + FABRICATED_RESULT_NOTE;
		removed += end - start;
		cursor = end;
	}
	if (removed === 0) return { text, removed: 0, complete };
	out += text.slice(cursor);
	return { text: out, removed, complete };
}

/**
 * One pass of everything that applies to a complete text fragment: fabricated
 * results first (so their payload is not mistaken for a tool call), then control
 * tokens.
 * @param {string} text
 * @returns {{ text: string, fabricated: number, tokens: number }}
 */
export function cleanText(text) {
	const fabricated = neutralizeFabricatedResults(text);
	const tokens = stripControlTokens(fabricated.text);
	return { text: tokens.text, fabricated: fabricated.removed > 0 ? 1 : 0, tokens: tokens.removed };
}
