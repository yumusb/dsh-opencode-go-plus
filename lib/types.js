// @ts-check
/**
 * Shared shape docs for the adapter's settings generation.
 * @module dsh-opencode-go-plus/types
 */

/**
 * One configured model entry (settings `models[]`).
 * @typedef {object} ModelEntry
 * @property {string} id - exact gateway model id.
 * @property {string} [name] - display name; catalog/`id` default otherwise.
 * @property {number} [contextWindow] - max combined request+response tokens.
 * @property {number} [maxTokens] - output capability and per-request default cap.
 * @property {readonly string[]} [input] - accepted modalities ("text"/"image").
 * @property {boolean} [reasoning] - whether the model reasons.
 * @property {readonly string[]} [efforts] - selectable thinking levels (wire == id).
 * @property {string} [offWire] - wire spelling of "off" when it is not "off".
 * @property {"openai-completions"|"anthropic-messages"|"openai-responses"} [api] - per-model wire protocol.
 */

/**
 * The resolved settings generation the adapter reads.
 * @typedef {object} ResolvedSettings
 * @property {string} providerRoute
 * @property {string} baseURL
 * @property {string} apiKeyEnv
 * @property {"catalog"|"selected"} modelSource - `catalog` serves the built-in
 *   catalog while `models` is empty; `selected` serves exactly `models`, so an
 *   empty list means nothing is enabled.
 * @property {number} retries
 * @property {number} timeoutMs
 * @property {number} defaultContextWindow
 * @property {number} defaultMaxTokens
 * @property {ModelEntry[]} models
 */

export {};
