// @ts-check
/**
 * Live model metadata from OpenCode's own catalog (`models.dev`).
 *
 * The GO gateway's `GET /v1/models` returns only `id`/`object`/`created`/
 * `owned_by` — no capabilities — so a client that relies on it alone cannot
 * tell that `deepseek-v4.1-flash` accepts images or that `minimax-m2.5` does
 * not. OpenCode publishes that machine-readable metadata at
 * `https://models.dev/api.json` under the `opencode-go` provider, including:
 *
 *   - `name`
 *   - `modalities.input`  → text / image / video / pdf
 *   - `limit.context` and `limit.output`
 *   - `reasoning` + `reasoning_options[].values` → thinking levels
 *   - `provider.npm`      → WHICH WIRE PROTOCOL the model is served on
 *
 * Probing the gateway for each capability is therefore unnecessary: this module
 * normalizes the official catalog into the shape {@link resolveEntry} merges,
 * It is the only metadata source: there is no built-in snapshot, because a
 * hand-maintained table drifts silently (see `catalog.js`).
 *
 * @module dsh-opencode-go-plus/modelsdev
 */

/** Where OpenCode publishes its provider/model catalog. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** The provider key this plugin's route mirrors in that catalog. */
export const MODELS_DEV_PROVIDER = "opencode-go";

/**
 * Wire protocol per AI SDK package, which is how the catalog publishes each
 * model's protocol: the provider names a default (`npm`) and a model overrides
 * it with its own `provider.npm`.
 *
 * This is the only machine-readable source for the distinction, and it is not
 * guessable from the model: `union-alpha` and `minimax-m2.7` answer ONLY the
 * Anthropic messages wire (chat completions returns 500), `grok-4.6` and
 * `gpt-5.6-luna` answer ONLY the Responses API (chat completions returns
 * "not supported for format oa-compat"), and the rest speak chat completions.
 * Probing cannot fully decide it either: several models accept both wires, so
 * only the catalog names the one the vendor intends.
 * @type {Record<string, "openai-completions"|"anthropic-messages"|"openai-responses">}
 */
const PROTOCOL_BY_NPM = {
	"@ai-sdk/openai-compatible": "openai-completions",
	"@ai-sdk/anthropic": "anthropic-messages",
	"@ai-sdk/openai": "openai-responses"
};

/**
 * Map one AI SDK package name to a wire protocol.
 * @param {unknown} npm
 * @returns {"openai-completions"|"anthropic-messages"|"openai-responses"|undefined}
 */
export function protocolForNpm(npm) {
	return typeof npm === "string" ? PROTOCOL_BY_NPM[npm] : undefined;
}

/**
 * One model's metadata, normalized to the plugin's internal catalog shape.
 * @typedef {object} ExternalEntry
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {readonly ("text"|"image")[]} [input]
 * @property {boolean} [reasoning]
 * @property {readonly string[]} [efforts]
 * @property {string} [offWire] - the model's "off" wire value ("none"), when the catalog names one.
 * @property {"openai-completions"|"anthropic-messages"|"openai-responses"} [api] - the wire protocol this model is served on.
 */

/**
 * Keep only the modalities this plugin's wires can actually carry. The catalog
 * also lists `video`/`pdf`, which neither the chat-completions nor the
 * messages request path here implements; claiming them would admit content the
 * adapter then refuses mid-turn.
 * @param {unknown} modalities - `model.modalities.input`.
 * @returns {readonly ("text"|"image")[]}
 */
export function supportedModalities(modalities) {
	if (!Array.isArray(modalities)) return [];
	/** @type {Array<"text"|"image">} */
	const kept = [];
	for (const modality of modalities) {
		if ((modality === "text" || modality === "image") && !kept.includes(modality)) kept.push(modality);
	}
	return kept;
}

/**
 * Flatten the catalog's `reasoning_options` into the plugin's effort-id list.
 * Only `type: "effort"` options name selectable levels; budgets and other
 * option kinds are not user-selectable thoughts here.
 *
 * `"none"` is not a selectable level — it is the catalog's spelling for the
 * model's *off* wire value (hy3 lists `["none","low","high"]`), so it is
 * pulled out separately as `offWire`.
 * @param {unknown} options - `model.reasoning_options`.
 * @returns {{ efforts: readonly string[], offWire: string|undefined }}
 */
export function effortLevels(options) {
	if (!Array.isArray(options)) return { efforts: [], offWire: undefined };
	/** @type {string[]} */
	const levels = [];
	/** @type {string|undefined} */
	let offWire;
	for (const option of options) {
		if (option === null || typeof option !== "object") continue;
		const values = /** @type {any} */ (option).values;
		if (!Array.isArray(values)) continue;
		for (const value of values) {
			if (typeof value !== "string" || value.length === 0) continue;
			if (value === "none") offWire = "none";
			else if (!levels.includes(value)) levels.push(value);
		}
	}
	return { efforts: levels, offWire };
}

/**
 * Normalize one catalog model entry. Only facts the catalog actually publishes
 * become fields; anything absent stays absent so the merge falls through to
 * never overwritten by `undefined`.
 *
 * `defaultProtocol` comes from the provider's own `npm`: a model without a
 * `provider.npm` override is served on the provider default.
 * @param {Record<string, unknown>} model
 * @param {"openai-completions"|"anthropic-messages"|"openai-responses"} [defaultProtocol]
 * @returns {ExternalEntry}
 */
export function normalizeModel(model, defaultProtocol) {
	const limit = /** @type {any} */ (model).limit;
	const name = typeof model.name === "string" && model.name.length > 0 ? model.name : undefined;
	const contextWindow = Number.isInteger(limit?.context) && limit.context > 0 ? limit.context : undefined;
	const maxTokens = Number.isInteger(limit?.output) && limit.output > 0 ? limit.output : undefined;
	const input = supportedModalities(/** @type {any} */ (model).modalities?.input);
	const { efforts, offWire } = effortLevels(/** @type {any} */ (model).reasoning_options);
	// per-model protocol: its own `provider.npm` override, else the provider default
	const api = protocolForNpm(/** @type {any} */ (model).provider?.npm) ?? defaultProtocol;
	return {
		...(api !== undefined ? { api } : {}),
		...(name !== undefined ? { name } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(input.length > 0 ? { input } : {}),
		...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		...(efforts.length > 0 ? { efforts } : {}),
		...(offWire !== undefined ? { offWire } : {})
	};
}

/**
 * Extract the whole `opencode-go` catalog as an id → metadata map.
 * @param {unknown} payload - the parsed `models.dev/api.json` document.
 * @returns {Map<string, ExternalEntry>}
 */
export function extractCatalog(payload) {
	/** @type {Map<string, ExternalEntry>} */
	const catalog = new Map();
	if (payload === null || typeof payload !== "object") return catalog;
	const provider = /** @type {any} */ (payload)[MODELS_DEV_PROVIDER];
	const models = provider?.models;
	if (models === null || typeof models !== "object") return catalog;
	// the provider names its own default protocol; models override it
	const defaultProtocol = protocolForNpm(provider?.npm);
	for (const [id, model] of Object.entries(models)) {
		if (id.length === 0 || model === null || typeof model !== "object") continue;
		catalog.set(id, normalizeModel(/** @type {Record<string, unknown>} */ (model), defaultProtocol));
	}
	return catalog;
}

/**
 * Fetch and normalize the live catalog.
 * @param {number} timeoutMs - per-attempt timeout.
 * @returns {Promise<Map<string, ExternalEntry>>}
 * @throws when the catalog cannot be reached or parsed.
 */
export async function fetchModelsDevCatalog(timeoutMs) {
	const res = await fetch(MODELS_DEV_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error(`models.dev ${res.status}`);
	const payload = await res.json();
	const catalog = extractCatalog(payload);
	if (catalog.size === 0) throw new Error("models.dev catalog has no opencode-go models");
	return catalog;
}
