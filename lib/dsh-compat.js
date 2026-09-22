// @ts-check
/**
 * Compatibility boundary for DSH host packages.
 *
 * DSH 0.1.0 / 0.1.1 predate two convenience exports added to dsh-llm:
 * `ToolCallId()` only brands a string at runtime, and
 * `resolveImageAttachmentAccess()` maps an optional attachment handle. Import
 * the host packages as namespaces so those hosts can still load this plugin,
 * then provide behavior-equivalent fallbacks for the two optional helpers.
 */

import * as dshLlm from "@deepseek-ai/dsh-llm";
import * as dshLaunchEnvironment from "@deepseek-ai/dsh-launch-environment";
import * as dshCredentials from "@deepseek-ai/dsh-credentials";

/**
 * @param {Record<string, unknown>} module
 * @param {string} packageName
 * @param {string} name
 */
function requiredExport(module, packageName, name) {
	const value = module[name];
	if (value === undefined) {
		throw new Error(
			`dsh-opencode-go-plus needs ${packageName}.${name}; update DSH or install a compatible plugin release`
		);
	}
	return value;
}

export const LlmAdapter = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "LlmAdapter"));
export const LlmError = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "LlmError"));
export const ReasoningEffortId = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "ReasoningEffortId"));
export const assertUsableApiKey = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "assertUsableApiKey"));
export const attributionHeaders = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "attributionHeaders"));
export const CONTEXT_WINDOW_EXCEEDED_CODE = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "CONTEXT_WINDOW_EXCEEDED_CODE"));
export const EMPTY_RESPONSE_CODE = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "EMPTY_RESPONSE_CODE"));
export const QUOTA_EXCEEDED_CODE = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "QUOTA_EXCEEDED_CODE"));
export const isContextWindowExceededError = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "isContextWindowExceededError"));
export const isQuotaExceededError = /** @type {any} */ (requiredExport(dshLlm, "@deepseek-ai/dsh-llm", "isQuotaExceededError"));
export const launchEnvironmentOf = /** @type {any} */ (requiredExport(dshLaunchEnvironment, "@deepseek-ai/dsh-launch-environment", "launchEnvironmentOf"));
export const credentialRef = /** @type {any} */ (requiredExport(dshCredentials, "@deepseek-ai/dsh-credentials", "credentialRef"));

// ToolCallId() is an identity brand at runtime. Older DSH hosts use plain
// strings here, so preserving the string is exactly their native behavior.
export function legacyToolCallId(/** @type {string} */ id) {
	return id;
}

export const ToolCallId = typeof dshLlm.ToolCallId === "function"
	? dshLlm.ToolCallId
	: legacyToolCallId;

/**
 * Map an image attachment to a read-only execution path on older DSH hosts.
 * It mirrors the helper introduced in dsh-llm 0.1.2; if that host has no
 * attachment mapper, image access remains unavailable rather than breaking a
 * text-only request.
 *
 * @param {any} attachments
 * @param {(hostPath: string) => string|undefined} mapHostPath
 * @param {any} ref
 */
export function legacyResolveImageAttachmentAccess(attachments, mapHostPath, ref) {
	const hostPath = typeof attachments?.imageHostPath === "function"
		? attachments.imageHostPath(ref)
		: undefined;
	if (hostPath === undefined) return undefined;
	const readonlyPath = mapHostPath(hostPath);
	return readonlyPath === undefined ? undefined : { readonlyPath };
}

export const resolveImageAttachmentAccess = typeof dshLlm.resolveImageAttachmentAccess === "function"
	? dshLlm.resolveImageAttachmentAccess
	: legacyResolveImageAttachmentAccess;
