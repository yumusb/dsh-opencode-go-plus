// @ts-check
/**
 * `OpenCodeGoAdapter` — the harness `LlmAdapter` for the OpenCode GO gateway.
 *
 * One configurable route (settings `providerRoute`) selects this adapter;
 * every fact a call needs — endpoint, key, models, per-model wire protocol,
 * context, modalities, thinking levels — resolves from the adapter's own
 * settings generation, never from `llm-pi-ai`. Per-model protocol is the
 * capability this adapter exists for: `union-alpha` speaks the Anthropic
 * messages wire, everything else chat completions, on one base URL.
 *
 * Every wire request carries `attributionHeaders()` (the adapter contract)
 * and the gateway's required `x-opencode-session` routing header keyed by the
 * harness session id, so the fetch-wrapper patch is never needed.
 *
 * @module dsh-opencode-go-plus/adapter
 */

import {
	LlmAdapter,
	LlmError,
	ReasoningEffortId,
	assertUsableApiKey,
	attributionHeaders
} from "./dsh-compat.js";
import { resolveEntry, servedEntries } from "./catalog.js";
import { streamVia, toPiContext, toPiModel } from "./pi-wire.js";

/**
 * The output cap sent on one request.
 *
 * Two different numbers live in the configuration and must not be confused:
 * a model's `maxTokens` is its output *capability* (a ceiling recorded from the
 * catalog), while the route's `defaultMaxTokens` is the cap this deployment
 * chooses to *send*. Sending the capability itself would ask the provider for
 * (for example) 384k tokens of output on every single request; the request cap
 * is therefore the route default, clamped by the capability and the context
 * window, and never below 1024 so reasoning upstreams can reserve answer room.
 * @param {{ maxTokens?: number, contextWindow?: number }} resolved
 * @param {{ defaultMaxTokens?: number, defaultContextWindow?: number }} config
 * @returns {number}
 */
function requestOutputCap(resolved, config) {
	const desired = config.defaultMaxTokens ?? 32768;
	const ceiling = resolved.maxTokens ?? desired;
	const context = resolved.contextWindow ?? config.defaultContextWindow;
	const bounded = Math.min(desired, ceiling);
	return Math.max(context !== undefined && context > 0 ? Math.min(bounded, context) : bounded, 1024);
}

/**
 * Selectable reasoning-effort display names, per UI language. These label the
 * picker's thinking-level control, so they follow the harness locale rather
 * than a fixed language.
 */
const EFFORT_NAMES = Object.freeze({
	zh: { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" },
	en: { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" }
});

/**
 * The display label for one thinking level in the active language.
 * @param {string} level
 * @param {"zh"|"en"} [locale]
 * @returns {string}
 */
function effortLabel(level, locale = "zh") {
	return (EFFORT_NAMES[locale] ?? EFFORT_NAMES.zh)[level] ?? level;
}

/**
 * Collect and read the request images of one call.
 * @param {import("@deepseek-ai/dsh-llm").GenerateOptions} options
 * @param {unknown} [attachments] - the AttachmentStore service, when mounted.
 * @param {boolean} acceptsImages - whether this model declared image input.
 * @returns {Promise<Map<string, { data: Uint8Array, mediaType: string, width: number, height: number }>>}
 */
async function prepareImages(options, attachments, acceptsImages) {
	const images = new Map();
	if (!acceptsImages || attachments === undefined || attachments === null) return images;
	/** @type {import("@deepseek-ai/dsh-llm").ImageAttachmentRef[]} */
	const refs = [];
	const collect = (/** @type {readonly import("@deepseek-ai/dsh-llm").ContentBlock[]} */ content) => {
		for (const block of content) {
			if (block.type === "image" && block.offloaded !== true) {
				if (!refs.some((ref) => ref.attachmentId === block.attachment.attachmentId)) refs.push(block.attachment);
			} else if (block.type === "tool-result") collect(block.content);
		}
	};
	for (const message of options.messages) if (message.role === "user") collect(message.content);
	if (refs.length === 0) return images;
	/** @type {{ readImageRequest(ref: any, target: any, signal?: AbortSignal): Promise<any> }} */
	const store = /** @type {any} */ (attachments);
	const versions = await Promise.all(refs.map((ref) => store.readImageRequest(
		ref,
		imageRequestTarget(ref, ref.width, ref.height),
		options.signal
	)));
	refs.forEach((ref, index) => {
		const version = versions[index];
		images.set(ref.attachmentId, {
			data: version.data,
			mediaType: version.mediaType,
			width: version.width,
			height: version.height
		});
	});
	// Base64-representation budget: one shared 20 MiB over encoded lengths.
	//
	// The count reported here is how many of the OLDEST occurrences must be
	// dropped for the request to fit; the image-offload plugin reads it from
	// the failure and retries the step with those images replaced by text.
	// Reaching this branch is the signal — the request is NOT sent as-is.
	const versionBytes = (/** @type {{ data: Uint8Array }} */ version) => Math.ceil(version.data.byteLength * 4 / 3);
	const ordered = refs.map((ref) => images.get(ref.attachmentId)).filter((version) => version !== undefined);
	const total = ordered.reduce((sum, version) => sum + versionBytes(version), 0);
	const maxBytes = 20 * 1024 * 1024;
	if (total > maxBytes) {
		let remaining = total;
		let offload = 0;
		while (remaining > maxBytes && offload < ordered.length) {
			remaining -= versionBytes(ordered[offload]);
			offload += 1;
		}
		throw new LlmError(
			`request images total ${total} bytes exceeds the ${maxBytes} request budget; offload the ${offload} oldest image(s) and retry`,
			"IMAGE_OFFLOAD_REQUIRED",
			{ offloadImages: offload }
		);
	}
	return images;
}

/**
 * The request-image ladder target for one attachment: bounded to a 2048 long
 * edge and a 2 MiB encoded-byte target — fits every GO gateway model observed.
 * @param {unknown} _ref
 * @param {number|undefined} width
 * @param {number|undefined} height
 */
function imageRequestTarget(_ref, width, height) {
	const longEdge = Math.max(width ?? 0, height ?? 0);
	const scale = longEdge > 2048 ? 2048 / longEdge : 1;
	return {
		width: Math.max(Math.round((width ?? 0) * scale), 1),
		height: Math.max(Math.round((height ?? 0) * scale), 1),
		maxBytes: 2 * 1024 * 1024
	};
}

export class OpenCodeGoAdapter extends LlmAdapter {
	/**
	 * @param {object} dependencies
	 * @param {() => import("./types.js").ResolvedSettings} dependencies.options - settings snapshot thunk.
	 * @param {(refName: string) => Promise<string>} dependencies.resolveApiKey
	 * @param {() => unknown} [dependencies.resolveAttachments]
	 * @param {import("@deepseek-ai/dsh-llm").ImageAttachmentAccessResolver} [dependencies.resolveImageAccess]
	 * @param {() => Map<string, import("./modelsdev.js").ExternalEntry>} [dependencies.metadata] -
	 *   the live `models.dev` catalog — the only metadata source.
	 */
	constructor({ options, resolveApiKey, resolveAttachments, resolveImageAccess, metadata, loadMetadata, locale }) {
		super();
		this.dependencies = { options, resolveApiKey, resolveAttachments, resolveImageAccess, metadata, loadMetadata, locale };
	}

	/** The active UI language for displayed labels ("zh" | "en"). */
	uiLocale() {
		return this.dependencies.locale?.() ?? "zh";
	}

	/** The live catalog when the host has loaded one, else an empty map. */
	catalog() {
		return this.dependencies.metadata?.() ?? new Map();
	}

	/**
	 * The resolved entry for one model, with the live catalog loaded if the
	 * entry needs it.
	 *
	 * A stored entry carries its own `api`, capacities and modalities, so it
	 * needs nothing else — that is what makes an offline deployment work. An
	 * entry lacking a protocol (a hand-written one, or one stored before the
	 * card wrote `api`) has to consult the catalog, so wait for that load
	 * instead of guessing a wire and failing obscurely at the gateway.
	 * @param {string} id
	 * @param {Record<string, unknown> & { id?: string }} entry
	 * @param {"zh"|"en"} [locale] - language for the displayed capability tags.
	 * @returns {Promise<ReturnType<typeof resolveEntry>>}
	 */
	async resolvedEntry(id, entry, locale) {
		const first = resolveEntry(id, entry, this.catalog(), locale);
		if (first.api !== undefined) return first;
		await this.dependencies.loadMetadata?.();
		const second = resolveEntry(id, entry, this.catalog(), locale);
		if (second.api === undefined) {
			throw new LlmError(
				`model "${id}" has no known wire protocol: enable it from the plugin card while online so the entry records one, or set "api" on its settings entry`,
				"INVALID_REQUEST"
			);
		}
		return second;
	}

	/** @override */
	providerInfo(provider) {
		// Deliberately NOT "OpenCode GO": that name belongs to the llm-pi-ai
		// route a user may also configure, and two identical labels in the model
		// picker cannot be told apart.
		return { id: provider, name: "OpenCode GO Plus" };
	}

	/** @override */
	providerRetryPolicy() {
		// The gateway TLS and upstream pool are flaky, so the transient set is
		// wider than the harness default and the count comes from `retries`.
		// The runtime captures this once per registration, so a change to
		// `retries` has to re-register — the host does that in `onChange`.
		const retries = this.dependencies.options().retries;
		return {
			mode: "normal",
			maxRetries: Number.isInteger(retries) && retries >= 0 ? retries : 3,
			retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "PROVIDER_ERROR"],
			initialDelayMs: 800,
			maxDelayMs: 15000,
			jitterRatio: 0.1
		};
	}

	/** Current settings generation's resolved entries (catalog when unset). */
	entries() {
		const config = this.dependencies.options();
		const live = this.catalog();
		const locale = this.uiLocale();
		return servedEntries(config.models, config.modelSource, live)
			.map((model) => ({ id: model.id, entry: resolveEntry(model.id, model, live, locale) }));
	}

	/** @override */
	async listModels(provider) {
		// the picker is typically the first consumer after a cold start, so let
		// the catalog load land before answering with bare ids
		if (this.catalog().size === 0) await this.dependencies.loadMetadata?.();
		return this.entries().map(({ id, entry }) => ({
			provider,
			id,
			name: entry.name ?? id,
			...(Array.isArray(entry.input) ? { inputModalities: /** @type {any} */ (entry.input) } : {})
		}));
	}

	/** @override */
	async resolveModel(provider, model, _signal) {
		const config = this.dependencies.options();
		const entry = config.models.find((candidate) => candidate.id === model) ?? { id: model };
		const locale = this.uiLocale();
		const resolved = await this.resolvedEntry(model, entry, locale);
		const reasoning = resolved.reasoning === true && Array.isArray(resolved.efforts) && resolved.efforts.length > 0
			? {
				efforts: ["off", ...resolved.efforts].map((id) => ({
					id: /** @type {any} */ (ReasoningEffortId(id)),
					name: effortLabel(id, locale)
				})),
				...(resolved.efforts.includes("high") || resolved.efforts.includes("max")
					? { defaultEffort: /** @type {any} */ (ReasoningEffortId(resolved.efforts.includes("high") ? "high" : "max")) }
					: {})
			}
			: undefined;
		return {
			provider,
			id: model,
			name: resolved.name ?? model,
			context: {
				contextWindow: resolved.contextWindow ?? config.defaultContextWindow
			},
			// the REQUEST cap (not the model's capability): the harness materializes
			// this when a caller names none, so reporting the 384k capability here
			// would ask every request for 384k output tokens
			defaultMaxTokens: requestOutputCap(resolved, config),
			...(reasoning !== undefined ? { reasoning } : {}),
			...(Array.isArray(resolved.input) ? { inputModalities: /** @type {any} */ (resolved.input) } : {})
		};
	}

	/** @override Bind one settings generation for both metadata and dispatch. */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream({ ...options, provider, model })
		};
	}

	/** @override */
	/**
	 * @override
	 *
	 * Every protocol decision lives in `pi-wire`: the model descriptor carries
	 * the model's own `api`, pi-ai encodes the request for it, and the event
	 * mapping back to harness chunks is protocol-independent. What stays here is
	 * what pi-ai cannot know — the route's own configuration, the credential
	 * reference, request images, and the gateway's session header.
	 */
	async *stream(options) {
		const config = this.dependencies.options();
		const route = options.provider ?? config.providerRoute;
		if (route !== config.providerRoute) {
			throw new LlmError(`route "${route}" is not served by this adapter`, "INVALID_REQUEST");
		}
		const key = await this.dependencies.resolveApiKey(config.apiKeyEnv);
		assertUsableApiKey(key, "dsh-opencode-go-plus", config.apiKeyEnv);

		const entry = config.models.find((candidate) => candidate.id === options.model) ?? { id: options.model };
		const resolved = await this.resolvedEntry(options.model, entry, this.uiLocale());
		const acceptsImages = Array.isArray(resolved.input) && resolved.input.includes("image");
		const images = await prepareImages(options, this.dependencies.resolveAttachments?.(), acceptsImages);

		const model = toPiModel({
			id: options.model,
			resolved,
			baseURL: config.baseURL,
			provider: config.providerRoute
		});
		const context = toPiContext({ options, images, api: resolved.api, provider: config.providerRoute });

		// An auxiliary call (the session-title generator) must not spend the
		// model's thinking budget: a title costs one short round trip.
		const auxiliary = options.purpose === "session-title";
		const effort = auxiliary ? undefined : /** @type {string|undefined} */ (options.reasoningEffort);
		// A caller-named cap wins; otherwise the route default, clamped.
		const maxTokens = options.maxTokens !== undefined && options.maxTokens > 0
			? Math.max(options.maxTokens, 1024)
			: requestOutputCap(resolved, config);

		yield* streamVia({
			model,
			context,
			options: {
				apiKey: key,
				// pi-ai owns the protocol's auth header; these ride alongside it.
				// `x-opencode-session` is required by the gateway for routing.
				headers: {
					...attributionHeaders(),
					// The gateway 400s any request without this header (verified
					// against both the official domain and relays). Every DSH
					// caller stamps a session id (agent loop, compaction,
					// session title, headless), so this is normally the real
					// per-conversation id — but a caller that omits it would 400
					// outright, so fall back to a route-stable sentinel that
					// keeps the request routable.
					"x-opencode-session": String(
						options.sessionId !== undefined && options.sessionId !== null
							? options.sessionId
							: "dsh-opencode-go-plus"
					)
				},
				// the harness owns retries (dsh-llm-retry); pi-ai must not add its own
				maxRetries: 0,
				// Without this the Anthropic SDK applies its own 10-minute default,
				// so a stalled connection hangs the turn instead of failing fast
				// into the harness's retry path.
				timeoutMs: config.streamTimeoutMs,
				...(effort !== undefined && effort !== "off" ? { reasoning: effort } : {}),
				maxTokens,
				...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
				...(options.signal !== undefined ? { signal: options.signal } : {})
			}
		});
	}
}
