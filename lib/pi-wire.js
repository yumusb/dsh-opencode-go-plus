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
				if (block.text.length > 0) parts.push({ type: "text", text: block.text });
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
					parts.push({ type: "thinking", thinking: block.text, thinkingSignature: "reasoning_content" });
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
 * Map pi-ai's terminal message to a harness finish reason, surfacing context
 * overflow and empty responses as the codes the harness reacts to.
 *
 * Error text is classified (see {@link classifyPiAiError}) rather than collapsed
 * into one terminal code, because the code is what selects the retry policy.
 * @param {any} message
 * @param {number} contextWindow
 * @returns {import("@deepseek-ai/dsh-llm").FinishReason}
 */
function mapStopReason(message, contextWindow) {
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
	switch (message?.stopReason) {
		case "stop":
			return Array.isArray(message.content) && message.content.length === 0
				? { kind: "error", failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE_CODE } }
				: { kind: "stop" };
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
	/** @type {Map<number, { id: string, name: string }>} */
	const toolIds = new Map();
	for await (const event of events) {
		switch (event.type) {
			case "start":
				break;
			case "text_start":
				yield { type: "block-start", index: event.contentIndex, blockType: "text" };
				break;
			case "text_delta":
				yield { type: "text-delta", index: event.contentIndex, text: event.delta };
				break;
			case "text_end":
				yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
				break;
			case "thinking_start":
				yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
				break;
			case "thinking_delta":
				yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
				break;
			case "thinking_end":
				yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
				break;
			case "toolcall_start": {
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
			case "done":
				yield { type: "usage", usage: mapUsage(event.message?.usage) };
				yield { type: "finish", reason: mapStopReason(event.message, model.contextWindow) };
				return;
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
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
