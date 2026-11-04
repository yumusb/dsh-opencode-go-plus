// @ts-check
/**
 * Minimal stand-in for `@deepseek-ai/dsh-launch-environment`.
 *
 * The real package is part of the DSH app bundle. `dsh-compat.js` only needs the
 * accessor that resolves an environment object from a launch handle; tests never
 * exercise a real launch, so an identity-ish accessor is enough.
 */

/** @param {unknown} launch */
export function launchEnvironmentOf(launch) {
	return launch?.environment ?? {};
}
