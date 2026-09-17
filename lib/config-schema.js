// @ts-check

// A checkout-installed plugin may have no resolvable node_modules, so keep the
// settings schema self-contained (no schemastery import; a hand-rolled
// validator plus the standard descriptor).
//
// The namespace IS the provider profile now: one route, one gateway base, one
// models list. Nothing here touches `llm-pi-ai`.

export const DEFAULTS = Object.freeze({
	providerRoute: "opencode-go-plus",
	baseURL: "https://opencode.ai/zen/go",
	apiKeyEnv: "OPENCODE_GO_API_KEY",
	/**
	 * Where the served model list comes from: `catalog` serves everything the
	 * live catalog lists while `models` is empty, `selected` serves EXACTLY
	 * `models` (so an empty list means "nothing enabled" rather than
	 * "everything"). The apply route writes `selected` whenever a user commits a
	 * pick, which is what makes "disable every model" expressible.
	 */
	modelSource: "catalog",
	retries: 3,
	timeoutMs: 15000,
	defaultContextWindow: 262144,
	defaultMaxTokens: 32768,
	models: Object.freeze([])
});

/** The allowed `modelSource` values. */
export const MODEL_SOURCES = Object.freeze(["catalog", "selected"]);

/**
 * The wire protocols a stored entry may name. Kept here because this schema is
 * deliberately dependency-free; `pi-wire` is the runtime authority and a test
 * asserts the two agree, so a protocol added there cannot be silently
 * unwritable here — which is exactly what happened when `openai-responses` was
 * added: the card could select `grok-4.6`, but the write was refused.
 */
export const WIRE_PROTOCOLS = Object.freeze(["openai-completions", "anthropic-messages", "openai-responses"]);

const SCALARS = Object.freeze({
	providerRoute: "string",
	baseURL: "string",
	apiKeyEnv: "string",
	modelSource: "string",
	retries: "number",
	timeoutMs: "number",
	defaultContextWindow: "number",
	defaultMaxTokens: "number"
});

/** Optional string fields a model entry may carry (non-empty when present). */
const MODEL_STRINGS = Object.freeze(["name", "offWire"]);

/** Optional positive-integer fields a model entry may carry. */
const MODEL_INTS = Object.freeze(["contextWindow", "maxTokens"]);

/** Optional string-array fields a model entry may carry. */
const MODEL_STRING_ARRAYS = Object.freeze(["input", "efforts"]);

/**
 * Validate one configured model entry. Returns `{ issues }` or `{ entry }`.
 * @param {unknown} entry
 */
function validateModelEntry(entry) {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		return { issues: [{ message: "expected object", path: [] }] };
	}
	const source = /** @type {Record<string, unknown>} */ (entry);
	if (typeof source.id !== "string" || source.id.length === 0) {
		return { issues: [{ message: "id must be a non-empty string", path: ["id"] }] };
	}
	/** @type {Record<string, unknown>} */
	const value = { id: source.id };
	/** @type {Array<{ message: string, path: string[] }>} */
	const issues = [];
	for (const key of MODEL_STRINGS) {
		const candidate = source[key];
		if (candidate === undefined || candidate === null) continue;
		if (typeof candidate !== "string" || candidate.length === 0) {
			issues.push({ message: "expected non-empty string", path: [key] });
		} else value[key] = candidate;
	}
	for (const key of MODEL_INTS) {
		const candidate = source[key];
		if (candidate === undefined || candidate === null) continue;
		if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) {
			issues.push({ message: "expected positive integer", path: [key] });
		} else value[key] = candidate;
	}
	if (source.reasoning !== undefined && source.reasoning !== null) {
		if (typeof source.reasoning !== "boolean") issues.push({ message: "expected boolean", path: ["reasoning"] });
		else value.reasoning = source.reasoning;
	}
	for (const key of MODEL_STRING_ARRAYS) {
		const candidate = source[key];
		if (candidate === undefined || candidate === null) continue;
		if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) {
			issues.push({ message: "expected array of strings", path: [key] });
		} else value[key] = candidate;
	}
	if (source.api !== undefined && source.api !== null) {
		if (!WIRE_PROTOCOLS.includes(/** @type {string} */ (source.api))) {
			issues.push({ message: `api must be one of ${WIRE_PROTOCOLS.join(", ")}`, path: ["api"] });
		} else value.api = source.api;
	}
	return issues.length > 0 ? { issues } : { entry: value };
}

/** @param {unknown} input */
function validate(input) {
	if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
		return { issues: [{ message: "expected object", path: [] }] };
	}
	const source = input == null ? {} : /** @type {Record<string, unknown>} */ (input);
	const value = { ...source };
	/** @type {Array<{ message: string, path: string[] }>} */
	const issues = [];
	for (const [key, type] of Object.entries(SCALARS)) {
		const candidate = source[key];
		if (candidate === undefined || candidate === null) value[key] = DEFAULTS[key];
		else if (typeof candidate !== type || (type === "number" && !Number.isFinite(candidate))) {
			issues.push({ message: `expected ${type}`, path: [key] });
		} else value[key] = candidate;
	}
	if (typeof value.providerRoute !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.providerRoute)) {
		issues.push({ message: "providerRoute must be a lowercase hyphenated route key", path: ["providerRoute"] });
	}
	if (!MODEL_SOURCES.includes(/** @type {string} */ (value.modelSource))) {
		issues.push({ message: `modelSource must be one of ${MODEL_SOURCES.join(", ")}`, path: ["modelSource"] });
	}
	const models = source.models;
	if (models === undefined || models === null) value.models = [];
	else if (!Array.isArray(models)) issues.push({ message: "expected array", path: ["models"] });
	else {
		/** @type {Array<Record<string, unknown>>} */
		const entries = [];
		models.forEach((entry, index) => {
			const result = validateModelEntry(entry);
			if (result.issues !== undefined) {
				for (const issue of result.issues) {
					issues.push({ message: issue.message, path: [`models.${index}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}`] });
				}
			} else entries.push(result.entry);
		});
		value.models = entries;
	}
	return issues.length > 0 ? { issues } : { value };
}

/** @param {unknown} input */
export function Config(input) {
	const result = validate(input);
	if (result.issues !== undefined) {
		const issue = result.issues[0];
		throw new TypeError(`${issue.path.length > 0 ? `$.${issue.path.join(".")} ` : ""}${issue.message}`);
	}
	return result.value;
}

Object.defineProperty(Config, "~standard", {
	value: { version: 1, vendor: "dsh-opencode-go-plus", validate }
});

Config.toJSON = () => ({
	uid: 10,
	refs: {
		1: { type: "string", meta: { default: DEFAULTS.providerRoute } },
		2: { type: "string", meta: { default: DEFAULTS.baseURL } },
		3: { type: "string", meta: { default: DEFAULTS.apiKeyEnv } },
		4: { type: "number", meta: { default: DEFAULTS.retries } },
		5: { type: "number", meta: { default: DEFAULTS.timeoutMs } },
		6: { type: "number", meta: { default: DEFAULTS.defaultContextWindow } },
		7: { type: "number", meta: { default: DEFAULTS.defaultMaxTokens } },
		8: { type: "array" },
		9: { type: "string", meta: { default: DEFAULTS.modelSource } },
		10: {
			type: "object",
			meta: { default: {} },
			dict: { providerRoute: 1, baseURL: 2, apiKeyEnv: 3, retries: 4, timeoutMs: 5, defaultContextWindow: 6, defaultMaxTokens: 7, models: 8, modelSource: 9 }
		}
	}
});
