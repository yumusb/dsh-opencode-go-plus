// @ts-check
/**
 * The wire layer, delegated to the authoritative implementation.
 *
 * Encoding a request and decoding a stream differ per protocol (chat
 * completions, Anthropic messages, OpenAI responses) and the GO gateway serves
 * all three. Rather than hand-rolling each one — where a subtle mistake
 * silently corrupts tool arguments or drops reasoning — this module hands the
 * encoding to `@earendil-works/pi-ai`, the same MIT-licensed library DSH's own
 * `llm-pi-ai` adapter uses, and keeps only what pi-ai cannot know:
 *
 *   - which protocol each model speaks (from the catalog, see `catalog.js`),
 *   - the endpoint shape that protocol expects,
 *   - the DSH ⇄ pi-ai message and chunk vocabulary.
 *
 * The conversion below is therefore written ONCE and serves every protocol,
 * instead of once per protocol as before.
 *
 * @module dsh-opencode-go-plus/pi-wire
 */

import { isContextOverflow } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	CONTEXT_WINDOW_EXCEEDED_CODE,
	EMPTY_RESPONSE_CODE,
	LlmError,
	QUOTA_EXCEEDED_CODE,
	ToolCallId,
	isContextWindowExceededError,
	isQuotaExceededError
} from "./dsh-compat.js";
import { cleanText } from "./dsml.js";
import { RepairStream, recordStream, repairCounters, repairSwitches } from "./repair.js";

/**
 * Strip control protocol from replayed assistant text.
 *
 * The transcript is the model's own example: leaving a DSML invoke marker in the
 * history teaches the next turn to write it again, which is how one bad turn
 * becomes a pattern. Only markers are removed — user and tool content, and the
 * reasoning passback mechanism, are untouched.
 * @param {unknown} value
 * @returns {string}
 */
function cleanForReplay(value) {
	if (typeof value !== "string" || value.length === 0) return "";
	return cleanText(value).text;
}

/**
 * One provider-streams implementation per protocol, built once: the lazy
 * export is a factory and the result is stateless.
 * @type {Record<string, any>}
 */
const STREAMS = {
	"anthropic-messages": anthropicMessagesApi(),
	"openai-completions": openAICompletionsApi(),
	"openai-responses": openAIResponsesApi()
};

/** Every wire protocol this plugin can drive. */
export const SUPPORTED_PROTOCOLS = Object.freeze(Object.keys(STREAMS));

/** No-cost descriptor: this plugin reports spend through usage, not pricing. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * The endpoint a protocol expects in `Model.baseUrl`.
 *
 * The two families disagree, and the catalog confirms it (`.../zen/go` for
 * anthropic, `.../zen/go/v1` for openai): the Anthropic SDK appends
 * `/v1/messages` to whatever it is given, while the OpenAI SDKs append only
 * `/chat/completions` or `/responses` and expect the version segment to be
 * present already. A single configured `baseURL` therefore has to be
 * normalized per protocol, or one family would request a doubled `/v1/v1`.
 * @param {string} baseURL - the configured gateway base.
 * @param {string} api - the protocol.
 * @returns {string}
 */
export function endpointFor(baseURL, api) {
	const base = String(baseURL ?? "").replace(/\/+$/, "");
	if (api === "anthropic-messages") return base.replace(/\/v\d+$/, "");
	return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/**
 * Build the pi-ai model descriptor for one configured entry. pi-ai dispatches
 * on `api`, which is why a single route can serve models on different wires.
 * @param {object} input
 * @param {string} input.id
 * @param {ReturnType<import("./catalog.js").resolveEntry>} input.resolved
 * @param {string} input.baseURL - configured gateway base.
 * @param {string} input.provider - the pi-ai provider id (used for reporting).
 * @returns {any}
 */
export function toPiModel({ id, resolved, baseURL, provider }) {
	const efforts = Array.isArray(resolved.efforts) ? resolved.efforts : [];
	// pi-ai reads a thinking level through thinkingLevelMap; "off" maps to the
	// model's off wire (null = send nothing, as the catalog records it)
	/** @type {Record<string, string|null>} */
	const thinkingLevelMap = {};
	if (resolved.reasoning === true && efforts.length > 0) {
		thinkingLevelMap.off = resolved.offWire ?? null;
		for (const level of efforts) thinkingLevelMap[level] = level;
	}
	// The gateway accepts `system` and rejects `developer` with HTTP 400
	// ("unknown variant `developer`"), verified against both the official
	// domain and a relay.
	//
	// pi-ai decides this from `model.reasoning && compat.supportsDeveloperRole`,
	// where the detected default is derived from the provider NAME and baseUrl:
	// it excludes only `provider === "opencode"` and URLs containing
	// `opencode.ai`. This plugin's route is configurable and its gateway is often
	// a relay, so neither matches and pi-ai would promote the prompt:
	//   - chat completions + relay/custom URL  -> `developer` -> 400
	//   - responses, ANY url (incl. official)  -> `developer` -> 400
	// so every responses model, and every completions model behind a relay,
	// would fail on the first request. Declare the capability explicitly rather
	// than rely on detection that cannot see our configuration.
	//
	// DeepSeek-family completions models additionally need
	// `requiresReasoningContentOnAssistantMessages`: pi-ai's URL detection only
	// recognizes `deepseek.com`, so a relay-hosted DeepSeek model would omit
	// `reasoning_content` from replayed assistant messages. The official pi-ai
	// opencode-go catalog declares exactly this compat for its deepseek-v4*
	// models; this mirrors it. `thinkingFormat` is deliberately NOT copied —
	// it would change how the thinking REQUEST parameter is encoded, which the
	// relay has not been verified to accept.
	const compat = resolved.api === "openai-completions" || resolved.api === "openai-responses"
		? {
			supportsDeveloperRole: false,
			...(resolved.api === "openai-completions" && /deepseek/i.test(id)
				? { requiresReasoningContentOnAssistantMessages: true }
				: {})
		}
		: undefined;
	return {
		id,
		name: resolved.name ?? id,
		api: resolved.api,
		provider,
		baseUrl: endpointFor(baseURL, resolved.api),
		reasoning: resolved.reasoning === true,
		...(compat !== undefined ? { compat } : {}),
		...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
		input: Array.isArray(resolved.input) && resolved.input.length > 0 ? [...resolved.input] : ["text"],
		cost: NO_COST,
		contextWindow: resolved.contextWindow ?? 262144,
		maxTokens: resolved.maxTokens ?? 32768
	};
}

/**
 * Convert the DSH conversation into pi-ai's `Context`. This is the ONE
 * protocol-independent conversion: whatever pi-ai then does with it is the
 * authoritative encoding for the model's own protocol.
 *
 * `images` maps an attachment id to its prepared request bytes; `toolNames`
 * correlates a tool call's id with its name, which pi-ai's tool-result message
 * requires and the DSH block does not carry. `api` and `provider` stamp the
 * replayed assistant messages so pi-ai's `transformMessages` recognizes them
 * as this model's own output (`isSameModel`) — without the match it DOWNGRADES
 * thinking blocks to plain text and the DeepSeek-style passback is lost.
 * Reasoning blocks are replayed only on `openai-completions`: DeepSeek-style
 * endpoints reject a thinking request whose assistant history lacks
 * `reasoning_content` ("The `reasoning_content` in the thinking mode must be
 * passed back to the API"). The Anthropic serializer would treat the
 * signature as its own base64 thinking signature and reject the forgery.
 * @param {object} input
 * @param {import("@deepseek-ai/dsh-llm").GenerateOptions} input.options
 * @param {Map<string, { data: Uint8Array, mediaType: string }>} input.images
 * @param {string} [input.api] - resolved wire protocol of the called model.
 * @param {string} [input.provider] - pi-ai provider id the model descriptor uses.
 * @returns {any}
 */
export function toPiContext({ options, images, api, provider = "dsh-opencode-go-plus" }) {
	/** @type {any[]} */
	const messages = [];
	/** @type {Map<string, string>} */
	const toolNames = new Map();

	/** Convert one user-side block list into pi-ai content parts. */
	const contentOf = (/** @type {readonly any[]} */ blocks) => {
		/** @type {any[]} */
		const parts = [];
		for (const block of blocks) {
			if (block.type === "text") {
				if (block.text.length > 0) parts.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				if (block.offloaded === true) continue; // placeholder text was projected upstream
				const version = images.get(block.attachment.attachmentId);
				if (version === undefined) continue;
				parts.push({
					type: "image",
					// pi-ai takes base64 in `data` and the mime type in `mimeType`
					data: Buffer.from(version.data).toString("base64"),
					mimeType: version.mediaType
				});
			}
		}
		return parts;
	};

	for (const message of options.messages) {
		if (message.role === "system") continue; // handled as systemPrompt
		if (message.role === "user") {
			// a tool result is its own pi-ai message kind
			if (/** @type {any} */ (message.source)?.kind === "tool") {
				const result = /** @type {any} */ (message).content[0];
				messages.push({
					role: "toolResult",
					toolCallId: result.toolCallId,
					toolName: toolNames.get(String(result.toolCallId)) ?? "",
					content: contentOf(result.content ?? []),
					isError: result.isError === true,
					timestamp: Date.now()
				});
				continue;
			}
			const parts = contentOf(message.content);
			if (parts.length === 0) continue;
			// keep the compact string form when the message is text only
			messages.push({
				role: "user",
				content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts,
				timestamp: Date.now()
			});
			continue;
		}
		// assistant
		/** @type {any[]} */
		const parts = [];
		for (const block of message.content) {
			if (block.type === "text") {
				// Clean before replay: a marker that reached the transcript should
				// not be handed back to the model as an example to imitate.
				const text = cleanForReplay(block.text);
				if (text.length > 0) parts.push({ type: "text", text });
			} else if (block.type === "tool-call") {
				toolNames.set(String(block.id), block.name);
				let args = {};
				try { args = JSON.parse(block.arguments); } catch { args = {}; }
				parts.push({ type: "toolCall", id: block.id, name: block.name, arguments: args });
			} else if (block.type === "reasoning" && api === "openai-completions") {
				// DeepSeek-style thinking endpoints require assistant history to
				// carry `reasoning_content` back ("The `reasoning_content` in the
				// thinking mode must be passed back to the API"). pi-ai's
				// completions serializer emits the thinking text under exactly
				// this signature field name — it tags its own streamed reasoning
				// the same way, and `parseOpenAIReasoningDetails` tolerates the
				// non-JSON value. Anthropic replays must NOT set it: there the
				// field means a base64 thinking signature and the endpoint would
				// reject the forgery.
				if (block.text.length > 0) {
					const thinking = cleanForReplay(block.text);
					if (thinking.length > 0) {
						parts.push({ type: "thinking", thinking, thinkingSignature: "reasoning_content" });
					}
				}
			}
		}
		if (parts.length === 0) continue;
		messages.push({
			role: "assistant",
			content: parts,
			api: api ?? "openai-completions",
			provider,
			model: options.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: NO_COST },
			stopReason: "stop",
			timestamp: Date.now()
		});
	}

	/** @type {string[]} */
	const systemParts = [];
	if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
	for (const message of options.messages) {
		if (message.role !== "system") continue;
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		if (text.length > 0) systemParts.push(text);
	}

	return {
		...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
		messages,
		...(Array.isArray(options.tools) && options.tools.length > 0
			? { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }
			: {})
	};
}

/**
 * Map pi-ai's usage counters to the harness vocabulary.
 * @param {any} usage
 * @returns {import("@deepseek-ai/dsh-llm").TokenUsage}
 */
function mapUsage(usage) {
	return {
		inputTokens: usage?.input ?? 0,
		outputTokens: usage?.output ?? 0,
		...(typeof usage?.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
		...(usage?.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
		...(usage?.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {})
	};
}

/**
 * Classify one pi-ai error message into a harness failure code.
 *
 * This decides whether the call is RETRIED: the adapter's retry policy lists
 * `TRANSPORT`, `TIMEOUT`, `RATE_LIMIT`, `SERVER` and quota as retryable, while
 * `PI_AI_ERROR` is deliberately terminal. Mapping every unrecognized failure to
 * `PI_AI_ERROR` therefore turned a transient network blip into a hard failure —
 * the harness had nothing to retry on, and pi-ai was told `maxRetries: 0`.
 *
 * A dropped connection surfaces here as the Anthropic SDK's "Connection error."
 * (its `APIConnectionError`), which must classify as `TRANSPORT`, not
 * `PI_AI_ERROR`.
 * @param {string} message
 * @returns {string}
 */
export function classifyPiAiError(message) {
	// A 403 from this gateway is usually a refusal, not a credential problem:
	// opt-in models answer with DataPolicyError, geo-blocked ones with
	// RegionError. DSH's chat and trajectory UI replace an AUTH failure's
	// message with a fixed "invalid API key" string and discard the original
	// text, so folding every 403 into AUTH made a region restriction look like
	// a bad key. Each refusal keeps its own code — which is not AUTH, and
	// therefore reaches the UI verbatim: the DataPolicyError text carries the
	// opt-in URL, and RegionError states why the model is unavailable.
	if (/DataPolicyError|requires explicit opt in/i.test(message)) return "DATA_POLICY";
	// AUTH is the one code the UI translates, so reserve it for genuine
	// credential failures and let every other status speak for itself.
	if (/\b401\b/.test(message)) return "AUTH";
	if (/invalid.?api.?key|incorrect api key|authentication_error|autherror|unauthor/i.test(message)) return "AUTH";
	if (/\b403\b|forbidden/i.test(message)) return "FORBIDDEN";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(message)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
		|| /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
		|| /\bterminated\b|premature close/i.test(message)) return "TRANSPORT";
	return "PI_AI_ERROR";
}

/**
 * Detect a `length` finish that cannot be a real output-cap truncation.
 *
 * The GO gateway occasionally ends a stream almost immediately and labels it
 * `finish_reason: "length"`. Observed sample: the answer stopped mid code block
 * after 162 characters and 315 ms, with no usage attached, while the request
 * asked for a 32k output budget. Passing that through as `max-tokens` tells the
 * user "your answer was too long" and, worse, keeps a half answer that the next
 * turn treats as complete.
 *
 * All three conditions must hold, deliberately conservative — a missed detection
 * only leaves today's (wrong but harmless) message, while a false positive costs
 * an extra retry and the tokens it re-generates:
 *
 *   1. pi-ai reports the wire stop reason as `length`;
 *   2. the stream took well under a second (no real answer takes that long to
 *      exhaust a large budget);
 *   3. the emitted text is short AND the reported output tokens are either
 *      missing or far below the requested cap.
 *
 * Small-budget requests (session titles, auxiliary calls) are never reclassified:
 * their caps are tiny enough that a genuine truncation looks identical.
 * @param {object} input
 * @param {any} input.reason - the mapped finish reason.
 * @param {any} input.message - pi-ai's terminal message.
 * @param {number} input.textChars - non-whitespace characters actually emitted.
 * @param {number} input.elapsedMs
 * @param {number|undefined} input.requestedMaxTokens
 * @returns {{ kind: "error", failure: { message: string, code: string } }|null}
 */
function suspectUpstreamTruncation({ reason, message, textChars, elapsedMs, requestedMaxTokens }) {
	if (reason?.kind !== "max-tokens") return null;
	if (message?.stopReason !== "length") return null;
	const requested = typeof requestedMaxTokens === "number" && requestedMaxTokens >= 4096 ? requestedMaxTokens : 0;
	if (requested === 0) return null;
	if (elapsedMs > 3000) return null;
	if (textChars > 1500) return null;
	const reported = Number(message?.usage?.output ?? 0);
	if (reported > requested * 0.1) return null;
	return {
		kind: "error",
		failure: {
			message: `upstream ended the stream early: finish_reason=length after ${textChars} chars / ${elapsedMs}ms, but the request allowed ${requested} output tokens`,
			code: "PROVIDER_ERROR"
		}
	};
}

/**
 * Map pi-ai's terminal message to a harness finish reason, surfacing context
 * overflow and empty responses as the codes the harness reacts to.
 *
 * Error text is classified (see {@link classifyPiAiError}) rather than collapsed
 * into one terminal code, because the code is what selects the retry policy.
 *
 * "Empty" is judged from what the caller ACTUALLY emitted (`evidence`), not from
 * `message.content`. pi-ai decodes `reasoning_content` into a `thinking` block,
 * so a completion carrying nothing but thinking has a non-empty `content` array
 * and used to be reported as a normal `stop`: the turn ended with no answer, no
 * error and no retry. Reasoning is not an answer.
 * @param {any} message
 * @param {number} contextWindow
 * @param {{ textChars: number, toolCalls: number }|undefined} [evidence]
 * @returns {import("@deepseek-ai/dsh-llm").FinishReason}
 */
function mapStopReason(message, contextWindow, evidence) {
	const errorMessage = String(message?.errorMessage ?? "");
	// overflow is detectable two ways: pi-ai's own usage-based signal, and the
	// provider's error text
	const overflow = isContextOverflow(message, contextWindow)
		|| (message?.stopReason === "error" && isContextWindowExceededError(errorMessage));
	if (overflow) {
		return {
			kind: "error",
			failure: {
				message: message?.errorMessage ?? `context window exceeded for model "${message?.model}"`,
				code: CONTEXT_WINDOW_EXCEEDED_CODE
			}
		};
	}
	/** Prompt tokens actually sent, including the cached prefix. */
	const promptTokens = (Number(message?.usage?.input) || 0) + (Number(message?.usage?.cacheRead) || 0);
	/** @param {string} detail */
	const empty = (detail) => {
		// Observed on this gateway: from roughly 300k prompt tokens on, the model
		// answers with reasoning only and never produces text, and retrying the
		// same prompt reproduces it. Say so, because "finished without an answer"
		// gives the reader nothing to act on and the fix is to shrink the context.
		if (promptTokens >= 290000) {
			return {
				kind: /** @type {const} */ ("error"),
				failure: {
					message: `model "${message?.model}" produced no answer with a ~${Math.round(promptTokens / 1000)}k-token prompt: at this size the gateway returns thinking-only completions. Compact the conversation or start a new one — retrying the same prompt will not help.`,
					code: EMPTY_RESPONSE_CODE
				}
			};
		}
		return {
			kind: /** @type {const} */ ("error"),
			failure: {
				message: `model "${message?.model}" finished without an answer (${detail})`,
				code: EMPTY_RESPONSE_CODE
			}
		};
	};
	switch (message?.stopReason) {
		case "stop": {
			if (typeof evidence?.textChars === "number") {
				// A marker converted into a real call: the tools must run, so this is
				// a tool-call turn even though the wire said "stop".
				if (evidence.toolCalls > 0) return { kind: "tool-calls" };
				if (evidence.textChars > 0) return { kind: "stop" };
				return empty("thinking-only or empty completion");
			}
			// Fallback for callers that carry no evidence (direct tests, older hosts).
			const blocks = Array.isArray(message.content) ? message.content : [];
			const hasText = blocks.some(
				(block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
			);
			const hasToolCall = blocks.some((block) => block.type === "toolCall");
			return hasText || hasToolCall ? { kind: "stop" } : empty("no text and no tool call");
		}
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		// `kind: "aborted"` is its own reason, NOT an error: the harness shows a
		// cancellation, and an aborted call must not be recorded as a failure
		case "aborted": return { kind: "aborted", failure: { message: message.errorMessage ?? "stream aborted", code: "ABORTED" } };
		case "pending": return { kind: "error", failure: { message: `stream for model "${message?.model}" ended pending`, code: "PI_AI_ERROR" } };
		case "deferred": return { kind: "error", failure: { message: `deferred response for model "${message?.model}" is not supported`, code: "PI_AI_ERROR" } };
		case "error": return { kind: "error", failure: { message: errorMessage || "provider stream failed", code: classifyPiAiError(errorMessage) } };
		default: return {
			kind: "error",
			failure: { message: errorMessage || `stopped: ${String(message?.stopReason)}`, code: classifyPiAiError(errorMessage) }
		};
	}
}

/**
 * Drive one model call through pi-ai and translate its events into harness
 * chunks. The event vocabulary is pi-ai's (`text_delta`, `thinking_delta`,
 * `toolcall_delta`, …) and is identical across protocols, which is what makes
 * this single mapping sufficient.
 * @param {object} input
 * @param {any} input.model - the pi-ai model descriptor.
 * @param {any} input.context
 * @param {object} input.options - request options (apiKey, reasoning, caps…).
 * @returns {AsyncIterable<import("@deepseek-ai/dsh-llm").StreamChunk>}
 */
export async function* streamVia({ model, context, options }) {
	const streams = STREAMS[model.api];
	if (streams === undefined) {
		throw new LlmError(`unsupported wire protocol "${model.api}" for model "${model.id}"`, "INVALID_REQUEST");
	}
	const events = streams.streamSimple(model, context, options);
	const switches = repairSwitches();
	// The safety gate: a marker only becomes a call when it names a tool this
	// request actually declared. Anything else is not a call we can honor.
	const toolNames = Array.isArray(context?.tools)
		? context.tools.map((tool) => String(tool?.name ?? "")).filter((name) => name.length > 0)
		: [];
	const repair = new RepairStream({
		toolNames,
		enabled: switches.enabled,
		stripSpecialTokens: switches.stripSpecialTokens,
		dropFabricated: switches.dropFabricated
	});
	/** @type {Map<number, { id: string, name: string }>} */
	const toolIds = new Map();
	/** @type {{ text: number|null, reasoning: number|null }} */
	const openBlock = { text: null, reasoning: null };
	let nextIndex = 0;
	let sawNativeToolCall = false;
	/** Wall-clock start, used to judge whether a `length` finish is plausible. */
	const startedAt = Date.now();
	/** @param {number|undefined} index */
	const noteIndex = (index) => {
		if (typeof index === "number" && Number.isInteger(index) && index >= nextIndex) nextIndex = index + 1;
	};
	/** @param {"text"|"reasoning"} channel @param {number} index */
	function* flushPending(channel, index) {
		for (const text of repair.end(channel)) {
			yield channel === "text"
				? { type: "text-delta", index, text }
				: { type: "reasoning-delta", index, text };
		}
	}
	/**
	 * Blocks the repair layer recovered from text/reasoning. A response that
	 * already carried native tool calls is not rewritten: the model's own calls
	 * are authoritative there, and duplicating them would run a tool twice.
	 */
	const repairedChunks = () => {
		/** @type {any[]} */
		const chunks = [];
		if (sawNativeToolCall) return chunks;
		for (const call of repair.takeCalls()) {
			const index = nextIndex;
			nextIndex += 1;
			chunks.push({ type: "block-start", index, blockType: "tool-call" });
			chunks.push({
				type: "tool-call-delta",
				index,
				id: /** @type {any} */ (ToolCallId(call.id)),
				name: call.name,
				argumentsDelta: call.argumentsJson
			});
			chunks.push({
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id: /** @type {any} */ (ToolCallId(call.id)),
					name: call.name,
					arguments: call.argumentsJson
				}
			});
		}
		return chunks;
	};
	/** @type {{ text: number, reasoning: number }} */
	const streamedChars = { text: 0, reasoning: 0 };
	for await (const event of events) {
		switch (event.type) {
			case "start":
				break;
			case "text_start":
				openBlock.text = event.contentIndex;
				streamedChars.text = 0;
				noteIndex(event.contentIndex);
				repair.beginBlock("text");
				yield { type: "block-start", index: event.contentIndex, blockType: "text" };
				break;
			case "text_delta":
				streamedChars.text += String(event.delta ?? "").length;
				for (const text of repair.push("text", event.delta)) {
					yield { type: "text-delta", index: event.contentIndex, text };
				}
				break;
			case "text_end":
				// Some protocols (openai-responses) deliver the finished block only,
				// with no per-delta events at all. Feed it through the repair layer so
				// the empty-response check sees the text it actually produced.
				if (streamedChars.text === 0 && typeof event.content === "string") {
					for (const text of repair.push("text", event.content)) {
						yield { type: "text-delta", index: event.contentIndex, text };
					}
				}
				for (const text of repair.end("text")) {
					yield { type: "text-delta", index: event.contentIndex, text };
				}
				openBlock.text = null;
				yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: repair.blockText("text") } };
				break;
			case "thinking_start":
				openBlock.reasoning = event.contentIndex;
				streamedChars.reasoning = 0;
				noteIndex(event.contentIndex);
				repair.beginBlock("reasoning");
				yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
				break;
			case "thinking_delta":
				streamedChars.reasoning += String(event.delta ?? "").length;
				// The reasoning channel gets the same treatment: a tool call written
				// into thinking is still a tool call the user expects to run.
				for (const text of repair.push("reasoning", event.delta)) {
					yield { type: "reasoning-delta", index: event.contentIndex, text };
				}
				break;
			case "thinking_end":
				if (streamedChars.reasoning === 0 && typeof event.content === "string") {
					for (const text of repair.push("reasoning", event.content)) {
						yield { type: "reasoning-delta", index: event.contentIndex, text };
					}
				}
				for (const text of repair.end("reasoning")) {
					yield { type: "reasoning-delta", index: event.contentIndex, text };
				}
				openBlock.reasoning = null;
				yield {
					type: "block-end",
					index: event.contentIndex,
					block: { type: "reasoning", text: repair.blockText("reasoning") }
				};
				break;
			case "toolcall_start": {
				sawNativeToolCall = true;
				noteIndex(event.contentIndex);
				const partial = event.partial?.content?.[event.contentIndex];
				const known = {
					id: partial?.type === "toolCall" ? String(partial.id) : "",
					name: partial?.type === "toolCall" ? String(partial.name) : ""
				};
				toolIds.set(event.contentIndex, known);
				yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" };
				break;
			}
			case "toolcall_delta": {
				const known = toolIds.get(event.contentIndex);
				yield {
					type: "tool-call-delta",
					index: event.contentIndex,
					id: /** @type {any} */ (ToolCallId(known?.id ?? "")),
					...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
					argumentsDelta: event.delta
				};
				break;
			}
			case "toolcall_end":
				yield {
					type: "block-end",
					index: event.contentIndex,
					block: {
						type: "tool-call",
						id: /** @type {any} */ (ToolCallId(String(event.toolCall.id))),
						name: String(event.toolCall.name),
						arguments: JSON.stringify(event.toolCall.arguments ?? {})
					}
				};
				break;
			case "done": {
				// Close a block pi-ai left open, flushing whatever it buffered.
				if (openBlock.text !== null) {
					const index = openBlock.text;
					for (const text of repair.end("text")) {
						yield { type: "text-delta", index, text };
					}
					yield { type: "block-end", index, block: { type: "text", text: repair.blockText("text") } };
					openBlock.text = null;
				}
				if (openBlock.reasoning !== null) {
					const index = openBlock.reasoning;
					for (const text of repair.end("reasoning")) {
						yield { type: "reasoning-delta", index, text };
					}
					yield { type: "block-end", index, block: { type: "reasoning", text: repair.blockText("reasoning") } };
					openBlock.reasoning = null;
				}
				for (const chunk of repairedChunks()) yield chunk;
				const evidence = repair.evidence();
				yield { type: "usage", usage: mapUsage(event.message?.usage) };
				let reason = mapStopReason(event.message, model.contextWindow, evidence);
				// The gateway sometimes reports `length` for a response it cut off
				// after a few hundred milliseconds (observed: 162 chars, 315ms, no
				// usage). Reporting that as "your answer was too long" is wrong and
				// silently keeps a half answer. See suspectUpstreamTruncation().
				const suspect = suspectUpstreamTruncation({
					reason,
					message: event.message,
					textChars: evidence.textChars,
					elapsedMs: Date.now() - startedAt,
					requestedMaxTokens: options?.maxTokens
				});
				if (suspect !== null) {
					repairCounters.suspectTruncations += 1;
					reason = suspect;
				}
				const emptyCompletion = reason.kind === "error" && reason.failure?.code === EMPTY_RESPONSE_CODE;
				recordStream(
					{
						converted: evidence.converted,
						unparsed: evidence.unparsed,
						strippedTokens: evidence.strippedTokens,
						fabricated: evidence.fabricated,
						degenerate: evidence.degenerate
					},
					emptyCompletion
				);
				if (switches.debug) logRepair(evidence, reason);
				yield { type: "finish", reason };
				return;
			}
			case "error": {
				const failure = event.error ?? {};
				yield { type: "usage", usage: mapUsage(failure.usage) };
				yield {
					type: "finish",
					reason: mapStopReason(
						options?.signal?.aborted === true ? { ...failure, stopReason: "aborted" } : failure,
						model.contextWindow
					)
				};
				return;
			}
			default:
				break;
		}
		// Runaway output: stop the stream and SAY it was truncated, so the caller
		// does not mistake a cut-off answer for a complete one.
		if (repair.degenerate) {
			repairCounters.degenerateAborts += 1;
			if (switches.debug) logRepair(repair.evidence(), { kind: "max-tokens" });
			yield { type: "finish", reason: { kind: "max-tokens" } };
			return;
		}
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}

/**
 * One debug line per stream when `DSH_OPENCODE_GO_REPAIR_DEBUG=1` is set. The
 * counters are the only way to tell "fixed" from "never happened".
 * @param {ReturnType<RepairStream["evidence"]>} evidence
 * @param {{ kind: string }} reason
 */
function logRepair(evidence, reason) {
	try {
		process.stderr.write(
			`[dsh-opencode-go-plus] repair ${JSON.stringify({
				finish: reason.kind,
				textChars: evidence.textChars,
				reasoningChars: evidence.reasoningChars,
				converted: evidence.converted,
				unparsed: evidence.unparsed,
				strippedTokens: evidence.strippedTokens,
				fabricated: evidence.fabricated,
				degenerate: evidence.degenerate,
				counters: { ...repairCounters }
			})}\n`
		);
	} catch {
		// logging must never break a stream
	}
}
