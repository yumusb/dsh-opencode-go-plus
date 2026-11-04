// @ts-check
/**
 * Minimal stand-in for `@deepseek-ai/dsh-llm`, for running this package's tests
 * outside a DSH host.
 *
 * The real package only exists inside the DSH app bundle, which keeps it out of
 * `node_modules` and therefore out of reach of `node --test`. Everything here is
 * behavior-equivalent for what `dsh-compat.js` and the adapter actually use: a
 * base adapter class, an error carrying a failure code, the reasoning-effort
 * brand, the empty/context/quota codes, and the attribution header helper.
 *
 * This is test scaffolding, never shipped: `package.json` excludes `test/`.
 */

/** Codes the harness reacts to; the adapter's retry policy keys off these. */
export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED";

/** A provider failure with a stable code. */
export class LlmError extends Error {
	/**
	 * @param {string} message
	 * @param {string} [code]
	 */
	constructor(message, code) {
		super(message);
		this.name = "LlmError";
		this.code = code ?? "PI_AI_ERROR";
	}
}

/** Base class the host's plugin contract expects. */
export class LlmAdapter {
	/** @param {unknown} dependencies */
	constructor(dependencies) {
		this.dependencies = dependencies;
	}
}

/** Brand-only helper at runtime. @param {string} id */
export function ReasoningEffortId(id) {
	return id;
}

/** Brand-only helper at runtime. @param {string} id */
export function ToolCallId(id) {
	return id;
}

/**
 * The host validates the key AND hands back the normalized value, so callers
 * probe/save exactly what was checked. Returning nothing here would make every
 * caller send `Bearer undefined` while still looking like a passing test.
 * @param {unknown} key @param {string} plugin @param {string} envName
 * @returns {string}
 */
export function assertUsableApiKey(key, plugin, envName) {
	if (typeof key !== "string" || key.trim().length === 0) {
		throw new LlmError(`${plugin}: no usable API key; set ${envName}`, "AUTH");
	}
	return key.trim();
}

/** @returns {Record<string, string>} */
export function attributionHeaders() {
	return { "user-agent": "dsh-opencode-go-plus-test" };
}

/** @param {string} message */
export function isContextWindowExceededError(message) {
	return /context window|too many tokens|maximum context/i.test(message);
}

/** @param {string} message */
export function isQuotaExceededError(message) {
	return /quota|insufficient balance/i.test(message);
}

/**
 * Identity for hosts that predate the helper; the real one maps a handle.
 * @param {unknown} _attachments
 * @param {(path: string) => string|undefined} _mapHostPath
 * @param {unknown} _ref
 */
export function resolveImageAttachmentAccess(_attachments, _mapHostPath, _ref) {
	return undefined;
}
