// @ts-check
/**
 * Minimal stand-in for `@deepseek-ai/dsh-credentials`.
 *
 * The real package lives in the DSH app bundle. `dsh-compat.js` only needs the
 * ref constructor, which the host treats as an identity brand at runtime.
 */

/** @param {string} name */
export function credentialRef(name) {
	return name;
}
