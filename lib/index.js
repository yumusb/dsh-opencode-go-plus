// @ts-check
/**
 * dsh-opencode-go-plus — host half.
 *
 * A STANDALONE OpenCode GO adapter: this plugin owns the model-picker route
 * outright (`ctx.llm.registerAdapter`) instead of writing into `llm-pi-ai`'s
 * configuration. Its settings namespace IS the provider profile — endpoint,
 * credential, model list, per-model wire protocol, context, modalities, and
 * thinking levels all resolve here; nothing in `llm-pi-ai`'s section is read
 * or written.
 *
 * What this buys over the pi-ai route:
 * - per-model protocol: `union-alpha` answers ONLY the Anthropic messages
 *   wire while every other gateway model speaks chat completions; one route,
 *   both protocols (llm-pi-ai's `api` is route-wide);
 * - the gateway's required `x-opencode-session` rides the adapter's own
 *   requests, so the fetch-wrapper injection never has to fire for it;
 * - capabilities (contextWindow / modalities / reasoning levels) are declared
 *   natively on `LlmResolvedModelInfo`.
 *
 * Surfaces:
 * - `GET  /opencode-go/models-info`    — configured model count (no network).
 * - `GET  /opencode-go/models-fetch`   — live gateway list as candidates (no write).
 * - `POST /opencode-go/models-apply`   — write exactly the picked ids.
 * - `GET  /opencode-go/models-refresh` — full-mirror sync of the live list.
 * - `/opencode-go-plus-refresh` chat command — same full-mirror action, text output.
 * - Browser card in Settings → Plugins (self-hosted bundle, boot-graph row).
 *
 * Coexistence: while a `llm-pi-ai` section still configures the same route
 * key, adapter registration is refused (`DUPLICATE_ADAPTER`); the plugin logs
 * the remedy and retries, so flipping over is a config edit — and both routes
 * work in parallel meanwhile.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { Config } from "./config-schema.js";
import { catalogEntryFields, catalogIds, normalizeLocale, resolveEntry, servedEntries } from "./catalog.js";
import { MODELS_DEV_PROVIDER, fetchModelsDevCatalog } from "./modelsdev.js";
import { OpenCodeGoAdapter } from "./adapter.js";

export { Config, WIRE_PROTOCOLS } from "./config-schema.js";

export const name = "dsh-opencode-go-plus";

/**
 * Required services. `settings` is declared because the web routes and the
 * chat command read and write this plugin's namespace through `ctx.settings`;
 * cordis refuses that access unless the service is injected. `credentials`,
 * `attachments`, and `fs` stay optional and are reached through `ctx.get`.
 */
export const inject = ["llm", "settings", "webServer", "commands"];

/** Settings namespace owned by this plugin. */
export const namespace = "dsh-opencode-go-plus";

const NS = namespace;

/** Checked route-key spelling (also enforced by the config schema). */
const ROUTE_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The active UI language, read from DSH's own `locale` settings namespace.
 * Absent or unknown falls back to `zh`, matching the rest of the harness.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @returns {"zh"|"en"}
 */
function uiLocale(ctx) {
	return normalizeLocale(ctx.settings.get("locale")?.preference);
}

/**
 * @typedef {Record<string, unknown> & { id: string }} ConfiguredModel
 */

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {string} refName
 * @returns {Promise<string|undefined>}
 */
async function resolveCredential(ctx, refName) {
	const credentials = ctx.get("credentials");
	const hit = credentials !== undefined ? await credentials.resolve(refName) : launchEnvironmentOf(ctx).get(refName);
	const value = /** @type {any} */ (hit)?.value;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {string} refName
 * @returns {Promise<string>}
 */
async function requireCredential(ctx, refName) {
	const value = await resolveCredential(ctx, refName);
	if (value === undefined) {
		throw new LlmError(
			`no API key — store credential ${refName} (Web Settings → Models, or ~/.dsh/.credentials.yaml)`,
			"MISSING_CREDENTIAL"
		);
	}
	return assertUsableApiKey(value, NS, refName);
}

/**
 * Read a JSON-shaped request body.
 * @param {import("http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text.length === 0 ? {} : JSON.parse(text));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * The wire base for gateway listing: settings `baseURL` with its version
 * segment (`.../v1`) normalized.
 * @param {string} baseURL
 */
function wireBase(baseURL) {
	const base = String(baseURL ?? "").replace(/\/+$/, "");
	return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

/**
 * Route keys in OTHER adapters that name this same service.
 *
 * The identity of the upstream is the provider key, not its URL: `opencode-go`
 * is OpenCode GO whether it is reached through the official domain or a relay,
 * and a route that leaves `baseURL` unset still serves the full catalog. So the
 * check is "is OpenCode GO configured somewhere else", which is also the thing a
 * user can see and reason about.
 *
 * Variants count too: a route like `opencode-go-anthropic` (a second route some
 * setups add for the Anthropic-wire models) duplicates the same models, so the
 * match is by prefix rather than equality.
 * @param {string} provider
 * @returns {boolean}
 */
function namesThisService(provider) {
	return provider === MODELS_DEV_PROVIDER || provider.startsWith(`${MODELS_DEV_PROVIDER}-`);
}

/**
 * Other CONFIGURED routes that serve this same gateway.
 *
 * DSH's built-in `llm-pi-ai` adapter can serve OpenCode GO on its own route, and
 * then the model picker lists every shared model twice — once per provider.
 * Nothing detects that automatically, and a duplicate is easy to miss because
 * the two entries carry different provider labels.
 *
 * "Configured" is the key test, and it is deliberately NOT the provider
 * directory: that directory lists every provider pi-ai ships (39 of them) as
 * addable, so its presence proves nothing. What matters is whether a route key
 * exists in the section's own `providers` dict — which is also why an empty
 * profile (`opencode-go: {}`) still counts: it serves the full catalog.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @returns {Array<{ provider: string, displayName: string, settingsNs: string, settingsPath: string[], apiKeyEnv: string|undefined, modelCount: number|null, removable: boolean }>}
 */
function findConflictingRoutes(ctx) {
	const conflicts = [];
	for (const entry of ctx.llm.listConfigurableProviders()) {
		if (entry.settingsNs === NS) continue; // this plugin's own route
		if (!namesThisService(entry.provider)) continue; // a different service
		const section = ctx.settings.get(entry.settingsNs);
		if (section === undefined || section === null) continue;
		// walk to the profile; `undefined` means the route is not configured at
		// all (the directory also lists providers nobody has added)
		/** @type {any} */
		let profile = section;
		for (const key of entry.settingsPath) {
			profile = profile?.[key];
			if (profile === undefined || profile === null) break;
		}
		if (profile === undefined || profile === null) continue;
		conflicts.push({
			provider: entry.provider,
			displayName: entry.displayName ?? entry.provider,
			settingsNs: entry.settingsNs,
			settingsPath: [...entry.settingsPath],
			apiKeyEnv: typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : undefined,
			// absent means the route serves the whole catalog, which the card
			// reports as "catalog-driven" rather than inventing a count
			modelCount: Array.isArray(profile.models) ? profile.models.length : null,
			// a whole-section profile has no single key to delete
			removable: entry.settingsPath.length > 0
		});
	}
	return conflicts;
}

/**
 * Tell the log about conflicting routes, once per distinct set.
 *
 * The card is the actionable surface, but a user comparing two provider entries
 * in the model picker may never open it. Logging the same finding at mount and
 * on settings changes puts it where a confused user already looks.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
let lastReportedConflicts = "";
function reportConflicts(ctx) {
	try {
		const conflicts = findConflictingRoutes(ctx);
		const summary = conflicts.map((entry) => entry.provider).sort().join(",");
		if (summary === lastReportedConflicts) return;
		lastReportedConflicts = summary;
		if (conflicts.length === 0) return;
		ctx.logger.warn(
			`dsh-opencode-go-plus: OpenCode GO is also configured on ${conflicts.map((entry) => `"${entry.provider}" (${entry.settingsNs})`).join(", ")} — `
			+ "every shared model will appear twice in the model picker; remove that route on the plugin card under Settings → Plugins"
		);
	} catch (error) {
		// diagnostics must never break settings handling
		ctx.logger.warn(`dsh-opencode-go-plus: conflict check failed (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * The provider route the harness default model points at, when one is set.
 * Removing that route would make the next request fail with `NO_ADAPTER`, so the
 * removal path refuses while it still names the route being removed.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @returns {string|undefined}
 */
function defaultModelProvider(ctx) {
	const selection = ctx.settings.get("agent-default-model");
	const provider = selection?.provider;
	return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}

/**
 * Read a response body as text, tolerating a body that cannot be read.
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function responseText(res) {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

/**
 * The auth headers one wire protocol expects. The two differ, and a gateway can
 * accept one while refusing the other, so a credential check must name which
 * protocol it tested.
 * @param {"openai-completions"|"anthropic-messages"} api
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
function authHeadersFor(api, apiKey) {
	return api === "anthropic-messages"
		? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
		: { authorization: `Bearer ${apiKey}` };
}

/**
 * The endpoint path one wire protocol posts to.
 * @param {"openai-completions"|"anthropic-messages"} api
 */
function completionPath(api) {
	return api === "anthropic-messages" ? "messages" : "chat/completions";
}

/**
 * Probe the gateway to learn whether a credential is ACTUALLY accepted.
 *
 * Why not `GET /v1/models`: that endpoint does not authenticate at all. A
 * bogus key, an empty key, and a request with no Authorization header all
 * return the same HTTP 200 listing, so it cannot tell a good key from a bad
 * one — using it as a "test connection" would report success for a credential
 * that every real call then rejects.
 *
 * The honest check is a request the gateway must authorize. An empty
 * `messages` array is rejected as invalid BEFORE any generation starts, so
 * this costs no tokens:
 *   - valid key   -> 400 invalid_request_error (auth passed, body refused)
 *   - invalid key -> 401 AuthError "Invalid API key."
 *   - unreachable -> transport error, surfaced as-is
 * @param {object} input
 * @param {string} input.baseURL
 * @param {string} input.apiKey
 * @param {"openai-completions"|"anthropic-messages"} input.api
 * @param {string} input.model - a model id to name in the probe.
 * @param {number} input.timeoutMs
 * @returns {Promise<{ ok: boolean, status: number, api: string, model: string, detail: string }>}
 */
async function probeCredential({ baseURL, apiKey, api, model, timeoutMs }) {
	const url = `${wireBase(baseURL)}/${completionPath(api)}`;
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				...authHeadersFor(api, apiKey),
				"x-opencode-session": "dsh-opencode-go-plus-credential-probe"
			},
			// deliberately invalid: rejected before any token is generated
			body: JSON.stringify({ model, max_tokens: 1, messages: [] }),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		// no verdict: nothing was answered, so there is nothing to localize yet
		return {
			ok: false,
			status: 0,
			api,
			model,
			detail: error instanceof Error ? error.message : String(error)
		};
	}
	const text = await responseText(res).catch(() => "");
	/** @type {any} */
	let parsed = null;
	try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
	const message = String(parsed?.error?.message ?? parsed?.message ?? text.slice(0, 200));
	// 2xx: the probe body was somehow accepted; the credential certainly works
	if (res.ok) return { ok: true, status: res.status, api, model, verdict: "accepted", detail: message };
	// anything the gateway refused for a reason OTHER than auth means the key
	// passed. A 403 is deliberately NOT treated as an auth failure: this
	// gateway uses it for policy and region refusals (DataPolicyError,
	// RegionError) where the credential itself is fine, and calling those
	// "rejected" made the connection test blame a key that works.
	const authFailure = res.status === 401 || /invalid.?api.?key|autherror|unauthor|authentication/i.test(message);
	if (authFailure) return { ok: false, status: res.status, api, model, verdict: "rejected", detail: message };
	// the key passed: a 400 is the healthy outcome (the probe body is empty on
	// purpose), and a 403 is a policy or region block on that particular model
	// — a real limitation, but not a credential one, so it is reported as
	// accepted-with-a-block rather than as a rejected key
	if (res.status === 400) return { ok: true, status: res.status, api, model, verdict: "accepted", detail: message };
	if (res.status === 403) return { ok: true, status: res.status, api, model, verdict: "accepted", blocked: true, detail: message };
	return { ok: false, status: res.status, api, model, verdict: "rejected", detail: message };
}

/**
 * Fetch the live gateway model id list with retries (TLS resets happen).
 * @param {string} url - the full listing URL.
 * @param {string} apiKey
 * @param {number} retries
 * @param {number} timeoutMs
 * @returns {Promise<string[]>}
 */
async function fetchLiveModels(url, apiKey, retries, timeoutMs) {
	/** @type {unknown} */
	let lastError = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!res.ok) {
				const body = await responseText(res).catch(() => "");
				throw new LlmError(`gateway ${res.status}: ${body.slice(0, 200)}`, "PROVIDER_ERROR", { status: res.status });
			}
			const json = await res.json();
			const data = Array.isArray(json?.data) ? json.data : null;
			if (data === null) throw new LlmError('gateway response has no "data" array', "INVALID_RESPONSE");
			const ids = data.map((entry) => entry?.id).filter((id) => typeof id === "string" && id.length > 0);
			if (ids.length === 0) throw new LlmError("gateway returned an empty model list", "INVALID_RESPONSE");
			return ids;
		} catch (error) {
			lastError = error;
			if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

/**
 * Compose the stored entries for the picked id list. Each entry carries the
 * catalog's display facts — Chinese-tagged name and the capacities the catalog
 * knows — so the Models page (which renders the settings entries themselves)
 * shows a model's name and context size without asking the adapter. An
 * existing entry's own values win, so user edits and unknown-model entries
 * survive a re-sync.
 * @param {string[]} pickedIds
 * @param {ConfiguredModel[]} existing
 * @returns {ConfiguredModel[]}
 */
function buildModelEntries(pickedIds, existing, live) {
	const previous = new Map(existing.map((entry) => [entry.id, entry]));
	return pickedIds.map((id) => /** @type {ConfiguredModel} */ ({
		...catalogEntryFields(id, live),
		...previous.get(id)
	}));
}

/**
 * The browser-card bundle revision: a short content hash.
 * @param {string} input
 */
function shortHash(input) {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/**
 * Inject one graph row into the index.html boot manifest
 * (`window.__DSH_BOOT__ = [...]`), skipping when the id is already present.
 * @param {string} html
 * @param {{ id: string, url: string, rev: string, inject?: string[], immediately?: boolean }} row
 */
function injectGraphRow(html, row) {
	const marker = "window.__DSH_BOOT__ = ";
	const start = html.indexOf(marker);
	if (start === -1) return html;
	const bodyStart = start + marker.length;
	const end = html.indexOf("</script>", bodyStart);
	if (end === -1) return html;
	let graph;
	try {
		graph = JSON.parse(html.slice(bodyStart, end).trim());
	} catch {
		return html;
	}
	if (!Array.isArray(graph)) return html;
	if (graph.some((entry) => entry !== null && typeof entry === "object" && entry.id === row.id)) return html;
	graph.push(row);
	return html.slice(0, bodyStart) + JSON.stringify(graph).replaceAll("<", "\\u003c") + html.slice(end);
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, unknown>} rawConfig - loader entry config (settings `base` layer).
 */
export function apply(ctx, rawConfig = {}) {
	// ── settings section ──────────────────────────────────────────────────
	let current = () => rawConfig;
	let lastRaw = /** @type {unknown} */ (undefined);
	let memoized = /** @type {ReturnType<typeof Config>|undefined} */ (undefined);
	/** Drop the memoized generation (called on every source attach/change). */
	const invalidate = () => {
		lastRaw = undefined;
		memoized = undefined;
	};
	const resolved = () => {
		const raw = current();
		if (raw === lastRaw && memoized !== undefined) return memoized;
		const next = /** @type {ReturnType<typeof Config>} */ (Config(raw));
		lastRaw = raw;
		memoized = next;
		return next;
	};
	resolved();

	// Image handle text: read-only workspace paths for the model's own
	// reference (offloaded placeholders and inline handles both use it).
	const imageAccess = (ref) => {
		const attachments = ctx.get("attachments");
		return attachments === undefined
			? undefined
			: resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref);
	};

	// ── live metadata (models.dev) ─────────────────────────────────────────
	// The gateway's own listing carries no capabilities, so the authoritative
	// modalities/capacities come from OpenCode's published catalog. It is
	// loaded in the background at mount and refreshed on every sync. There is
	// no offline model list: a configured entry carries its own facts.
	/** @type {Map<string, import("./modelsdev.js").ExternalEntry>} */
	let liveCatalog = new Map();
	/** @type {Promise<Map<string, import("./modelsdev.js").ExternalEntry>>|null} */
	let catalogInflight = null;
	const refreshLiveCatalog = () => {
		if (catalogInflight === null) {
			catalogInflight = fetchModelsDevCatalog(resolved().timeoutMs)
				.then((catalog) => {
					liveCatalog = catalog;
					return catalog;
				})
				.catch((error) => {
					ctx.logger.warn(`dsh-opencode-go-plus: models.dev metadata unavailable (${error instanceof Error ? error.message : String(error)}); stored entries still serve`);
					return liveCatalog;
				})
				.finally(() => {
					catalogInflight = null;
				});
		}
		return catalogInflight;
	};
	void refreshLiveCatalog();

	const adapter = new OpenCodeGoAdapter({
		options: resolved,
		// The key ref can be renamed in settings; resolve by the passed name.
		resolveApiKey: (ref) => requireCredential(ctx, typeof ref === "string" && ref.length > 0 ? ref : resolved().apiKeyEnv),
		resolveAttachments: () => ctx.get("attachments"),
		resolveImageAccess: imageAccess,
		metadata: () => liveCatalog,
		// lets the adapter await the catalog when a stored entry lacks a protocol
		loadMetadata: () => refreshLiveCatalog(),
		// read per call, so a language change reaches the picker without a restart
		locale: () => uiLocale(ctx)
	});

	// ── intentionally NOT registered as a configurable provider ────────────
	// DSH's own Models settings page only renders the two layouts it hardcodes
	// (`llm-deepseek`, `llm-pi-ai`); every other namespace falls to "unknown",
	// where that page substitutes a fixed note telling the user to edit
	// settings.yaml and renders NO fields at all. Listing this route there would
	// therefore show a dead entry with an unchangeable message. Instead this
	// plugin owns its UX in the Plugins settings card, which carries the same
	// controls (base URL, key, connection test, model selection).
	//
	// Nothing is lost by staying out of that directory: the chat model picker
	// reads the ADAPTER registry (`llm.listProviders` / `listModels`), never the
	// configurable-provider directory, so the route and its models stay selectable.

	// ── adapter registration (conflict-tolerant; retry on route collision) ─
	/** @type {import("@deepseek-ai/dsh-llm").AdapterRegistrationHandle|null} */
	let registration = null;
	/** @type {string|null} */
	let registeredRoute = /** @type {string|null} */ (null);
	/** The `retries` value the current registration captured, for change detection. */
	let registeredRetries = resolved().retries;
	/** @type {ReturnType<typeof setInterval>|undefined} */
	let retryTimer;
	const stopRetry = () => {
		if (retryTimer !== undefined) {
			clearInterval(retryTimer);
			retryTimer = undefined;
		}
	};
	function tryRegister() {
		const route = resolved().providerRoute;
		if (!ROUTE_KEY_RE.test(route)) return;
		if (route === registeredRoute) return;
		if (registration === null) {
			try {
				registration = ctx.llm.registerAdapter([route], adapter);
			} catch (error) {
				if (/** @type {any} */ (error)?.code !== "DUPLICATE_ADAPTER") throw error;
				if (retryTimer === undefined) {
					ctx.logger.warn(`dsh-opencode-go-plus: route "${route}" is currently owned by another adapter (llm-pi-ai?) — clear that route's configuration and restart dsh web; both routes work in parallel meanwhile; retrying every 30 s`);
					retryTimer = setInterval(function retry() {
						try {
							tryRegister();
						} catch {
							// keep retrying; the warn above explains the state
						}
					}, 30000);
					retryTimer.unref?.();
				}
				return;
			}
		} else {
			try {
				registration.replace([route]);
			} catch (error) {
				ctx.logger.error(`dsh-opencode-go-plus: keeping routes "${registeredRoute}" after a refused replace (${/** @type {any} */ (error)?.message ?? String(error)})`);
				return;
			}
		}
		registeredRoute = route;
		stopRetry();
	}
	tryRegister();

	// Model discovery is deliberately not registered: the official
	// "fetch available models" action only appears for routes listed in the
	// configurable-provider directory, which this plugin stays out of. The card
	// offers the same fetch through this plugin's own `models-fetch` route.

	// ── settings install ───────────────────────────────────────────────────
	// `settings` is an injected service, so the section installs directly and
	// the same context serves the routes below (`ctx.settings.update`).
	const hooks = /** @type {any} */ ({
		setSource: (source) => {
			current = source;
			invalidate();
		},
		onChange: () => {
			// re-judge every memoized resolution, as the seam requires: a source
			// that mutates in place keeps its identity, so caching by reference
			// alone would serve stale configuration
			invalidate();
			try {
				tryRegister();
				// A duplicate is only visible to someone who opens the settings
				// card, but the symptom (every model listed twice) shows up in the
				// picker — so also say it in the log, once per discovery.
				reportConflicts(ctx);
				// the runtime captures the retry policy at registration, so a
				// change to `retries` only takes effect through a replace
				if (registration !== null && registeredRetries !== resolved().retries) {
					registration.replace([resolved().providerRoute]);
					registeredRetries = resolved().retries;
				}
			} catch (error) {
				ctx.logger.error("dsh-opencode-go-plus: adapter registration failed");
				ctx.logger.error(/** @type {Error} */ (error));
			}
		}
	});
	ctx.settings.installSection(ctx, NS, Config, rawConfig, hooks);

	// ── web routes ─────────────────────────────────────────────────────────
	/** @param {import("http").ServerResponse} res */
	const jsonResponse = (res) => {
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
	};

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/models-info",
		handler: async (_req, res) => {
			jsonResponse(res);
			try {
				const config = resolved();
				const served = servedEntries(config.models, config.modelSource, liveCatalog);
				// the live listing costs one authenticated call; failure is not an
				// error here — it just means staleness cannot be reported
				/** @type {string[]|null} */
				let liveIds = null;
				let liveError = null;
				try {
					// no credential needed for the listing endpoint
					const url = `${wireBase(config.baseURL)}/models`;
					liveIds = await fetchLiveModels(url, (await resolveCredential(ctx, config.apiKeyEnv)) ?? "", config.retries, config.timeoutMs);
				} catch (error) {
					liveError = error instanceof Error ? error.message : String(error);
				}
				const servedIds = served.map((entry) => entry.id);
				res.end(JSON.stringify({
					ok: true,
					provider: config.providerRoute,
					baseURL: config.baseURL,
					apiKeyEnv: config.apiKeyEnv,
					keyConfigured: (await resolveCredential(ctx, config.apiKeyEnv)) !== undefined,
					modelSource: config.modelSource,
					configured: served.length,
					models: servedIds,
					fromCatalog: config.modelSource !== "selected" && config.models.length === 0,
					// enabled here but no longer offered by the gateway
					...(liveIds === null ? {} : { stale: servedIds.filter((id) => !liveIds.includes(id)) }),
					...(liveError === null ? {} : { liveError }),
					// sibling routes on the same gateway would duplicate every shared
					// model in the picker, so surface them for one-click removal
					conflicts: findConflictingRoutes(ctx),
					defaultModelProvider: defaultModelProvider(ctx)
				}));
			} catch (error) {
				res.statusCode = 500;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: models info route");

	// Remove a conflicting route from ANOTHER settings namespace.
	//
	// This is the only place the plugin writes outside its own section, and it
	// is deliberately narrow: it re-reads the namespace's raw user layer, deletes
	// exactly the one key naming the conflicting route, and writes the rest back
	// with a revision guard. Everything else in that namespace — other providers,
	// other fields — is preserved byte for byte. Nothing is removed implicitly;
	// the caller has to name the route.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/remove-route",
		handler: async (req, res) => {
			jsonResponse(res);
			try {
				const body = await readJsonBody(req);
				const settingsNs = typeof body.settingsNs === "string" ? body.settingsNs : "";
				const settingsPath = Array.isArray(body.settingsPath) ? body.settingsPath.filter((k) => typeof k === "string") : [];
				if (settingsNs.length === 0 || settingsPath.length === 0) {
					throw new Error("settingsNs and a non-empty settingsPath are required");
				}
				if (settingsNs === NS) {
					throw new Error("this route belongs to the plugin itself; disable models on the card instead");
				}
				// the configured route must still be a real conflict, so a stale or
				// forged request cannot delete an unrelated provider
				const config = resolved();
				const conflicts = findConflictingRoutes(ctx);
				const target = conflicts.find((entry) => entry.settingsNs === settingsNs
					&& entry.settingsPath.length === settingsPath.length
					&& entry.settingsPath.every((key, index) => key === settingsPath[index]));
				if (target === undefined) {
					throw new Error("that route is not a conflicting OpenCode GO route");
				}
				// a removal that orphans the default model turns into NO_ADAPTER on
				// the next request, so refuse it and say what to do first
				const defaultProvider = defaultModelProvider(ctx);
				if (defaultProvider !== undefined && defaultProvider === target.provider) {
					throw new Error(`the default model still uses route "${target.provider}"; point the default model at "${config.providerRoute}" (or another provider) first, then remove this route`);
				}
				const descriptor = ctx.settings.describe().find((entry) => entry.ns === settingsNs);
				if (descriptor === undefined) throw new Error(`settings namespace "${settingsNs}" is not registered`);
				const user = structuredClone(descriptor.user ?? {});
				/** @type {any} */
				let parent = user;
				for (const key of settingsPath.slice(0, -1)) {
					parent = parent?.[key];
					if (parent === null || typeof parent !== "object") {
						throw new Error(`"${settingsNs}" has no user setting at ${settingsPath.join(".")} — it may come from the composition layer, which cannot be edited here`);
					}
				}
				delete parent[settingsPath[settingsPath.length - 1]];
				await ctx.settings.replace(settingsNs, user, descriptor.revision);
				res.end(JSON.stringify({
					ok: true,
					removed: { settingsNs, settingsPath, provider: target.provider },
					remaining: findConflictingRoutes(ctx)
				}));
			} catch (error) {
				res.statusCode = 400;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: remove conflicting route");

	// ── connection settings (baseURL + API key) ────────────────────────────
	// The official Models page can also edit these, but keeping them on this
	// card means the whole integration is configurable in one place.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/config",
		handler: async (req, res) => {
			jsonResponse(res);
			try {
				const config = resolved();
				if (req.method !== "POST") {
					res.end(JSON.stringify({
						ok: true,
						baseURL: config.baseURL,
						apiKeyEnv: config.apiKeyEnv,
						keyConfigured: (await resolveCredential(ctx, config.apiKeyEnv)) !== undefined,
						modelSource: config.modelSource,
						providerRoute: config.providerRoute
					}));
					return;
				}
				const body = await readJsonBody(req);
				/** @type {Record<string, string>} */
				const patch = {};
				if (typeof body.baseURL === "string") {
					const next = body.baseURL.trim();
					if (next.length === 0) throw new Error("baseURL must not be empty");
					if (!/^https?:\/\//.test(next)) throw new Error("baseURL must start with http:// or https://");
					patch.baseURL = next;
				}
				if (typeof body.apiKeyEnv === "string") {
					const ref = body.apiKeyEnv.trim();
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("apiKeyEnv must be an environment-variable style name");
					patch.apiKeyEnv = ref;
				}
				if (Object.keys(patch).length > 0) await ctx.settings.update(NS, patch);
				// the key is written through the credentials seam, never settings
				if (typeof body.apiKey === "string" && body.apiKey.length > 0) {
					const ref = patch.apiKeyEnv ?? config.apiKeyEnv;
					const credentials = ctx.get("credentials");
					if (credentials === undefined) throw new Error("the credentials service is not mounted, so the key cannot be stored");
					await credentials.set(credentialRef(ref), body.apiKey.trim());
				}
				const next = resolved();
				res.end(JSON.stringify({
					ok: true,
					baseURL: next.baseURL,
					apiKeyEnv: next.apiKeyEnv,
					keyConfigured: (await resolveCredential(ctx, next.apiKeyEnv)) !== undefined,
					modelSource: next.modelSource
				}));
			} catch (error) {
				res.statusCode = 400;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: config route");

	// Test the stored connection AND the credential.
	//
	// Reachability alone is cheap but meaningless for auth (`/v1/models` never
	// authenticates), so this probes each wire protocol the configuration
	// actually uses — the two paths carry different auth headers, so a key can
	// work on one and not the other. `modelSource` decides the list, falling
	// back to one catalog entry when nothing is configured yet.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/test",
		handler: async (_req, res) => {
			jsonResponse(res);
			try {
				const config = resolved();
				const key = await requireCredential(ctx, config.apiKeyEnv);
				const live = liveCatalog;
				// one representative model per protocol in use
				const served = servedEntries(config.models, config.modelSource, live);
				const pool = served.length > 0 ? served : catalogIds(live).map((id) => ({ id }));
				/** @type {Map<string, string>} */
				const representatives = new Map();
				for (const entry of pool) {
					const api = resolveEntry(entry.id, entry, live).api;
					if (!representatives.has(api)) representatives.set(api, entry.id);
				}
				const started = Date.now();
				const checks = [];
				for (const [api, model] of representatives) {
					checks.push(await probeCredential({
						baseURL: config.baseURL,
						apiKey: key,
						api: /** @type {any} */ (api),
						model,
						timeoutMs: config.timeoutMs
					}));
				}
				const elapsed = Date.now() - started;
				const failed = checks.filter((check) => !check.ok);
				res.statusCode = failed.length > 0 ? 502 : 200;
				res.end(JSON.stringify({
					ok: failed.length === 0,
					baseURL: config.baseURL,
					apiKeyEnv: config.apiKeyEnv,
					ms: elapsed,
					checks,
					// kept for the card's "how many models does it serve" line
					models: pool.length,
					...(failed.length > 0 ? { error: failed.map((check) => `${check.api}:${check.detail}`).join("; ") } : {})
				}));
			} catch (error) {
				res.statusCode = 502;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: connection test route");

	// Full-mirror sync of the live list into the plugin's own model list.
	async function refreshAll() {
		const config = resolved();
		// the listing endpoint does not authenticate: browse before configuring
		const apiKey = (await resolveCredential(ctx, config.apiKeyEnv)) ?? "";
		const url = `${wireBase(config.baseURL)}/models`;
		const liveIds = await fetchLiveModels(url, apiKey, config.retries, config.timeoutMs);
		// metadata first, so the written entries carry correct modalities
		const metadata = await refreshLiveCatalog();
		const models = buildModelEntries(liveIds, config.models, metadata);
		// a mirror writes an explicit list, so the source becomes `selected`
		await ctx.settings.update(NS, { models, modelSource: "selected" });
		const oldIds = new Set(config.models.map((model) => model.id));
		return {
			total: liveIds.length,
			added: liveIds.filter((id) => !oldIds.has(id)),
			removed: [...oldIds].filter((id) => !liveIds.includes(id)),
			at: new Date().toISOString(),
			via: url
		};
	}

	/** Shared in-flight guard so the widget and the command never double-fetch. */
	/** @type {Promise<unknown>|null} */
	let inflight = null;
	function refreshOnce() {
		if (inflight === null) {
			inflight = refreshAll().finally(() => {
				inflight = null;
			});
		}
		return inflight;
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/models-refresh",
		handler: async (_req, res) => {
			jsonResponse(res);
			try {
				const result = await refreshOnce();
				res.end(JSON.stringify({ ok: true, ...result }));
			} catch (error) {
				res.statusCode = 502;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: models refresh route");

	// Candidate flow (the dialog): fetch the live list WITHOUT writing.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/models-fetch",
		handler: async (_req, res) => {
			jsonResponse(res);
			try {
				const config = resolved();
				// deliberately not `requireCredential`: `/v1/models` never
				// authenticates, so candidates are browsable without a key
				const apiKey = (await resolveCredential(ctx, config.apiKeyEnv)) ?? "";
				const url = `${wireBase(config.baseURL)}/models`;
				const liveIds = await fetchLiveModels(url, apiKey, config.retries, config.timeoutMs);
				const configured = new Set(config.models.map((model) => model.id));
				// the dialog shows modalities, so it needs live metadata too
				const metadata = await refreshLiveCatalog();
				// Candidates carry the PLAIN name plus structured facts; the card
				// composes its own localized description from them, so adding tags
				// here would duplicate them and pin the language to the host.
				const candidates = liveIds.map((id) => {
					const fields = catalogEntryFields(id, metadata);
					return {
						...fields,
						efforts: Array.isArray(fields.efforts) && fields.reasoning === true
							? ["off", ...fields.efforts]
							: null,
						enabled: configured.has(id)
					};
				});
				res.end(JSON.stringify({ ok: true, via: url, provider: config.providerRoute, candidates, configured: [...configured] }));
			} catch (error) {
				res.statusCode = 502;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: models fetch route");

	// Apply exactly the user's selection: write only the picked ids. An empty
	// pick is a legal state — it disables every model.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-opencode-go-plus/models-apply",
		handler: async (req, res) => {
			jsonResponse(res);
			try {
				const body = await readJsonBody(req);
				if (body.ids !== undefined && !Array.isArray(body.ids)) throw new Error("ids must be an array");
				const picked = Array.isArray(body.ids)
					? body.ids.filter((id) => typeof id === "string" && id.length > 0)
					: [];
				const config = resolved();
				const models = buildModelEntries(picked, config.models, liveCatalog);
				// `selected` (not the default `catalog`): committing an empty pick
				// means "enable nothing", which must not read as "serve everything"
				await ctx.settings.update(NS, { models, modelSource: "selected" });
				res.end(JSON.stringify({ ok: true, provider: config.providerRoute, total: models.length, models: models.map((model) => model.id) }));
			} catch (error) {
				res.statusCode = 400;
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
		}
	}), "dsh-opencode-go-plus: models apply route");

	// ── chat command ──────────────────────────────────────────────────────
	ctx.commands.register({
		name: "opencode-go-plus-refresh",
		description: "fetch the live OpenCode GO model list into this adapter's own route (model picker updates immediately)",
		handler: async () => {
			try {
				const result = await refreshOnce();
				const zh = uiLocale(ctx) === "zh";
				const added = result.added.length;
				const removed = result.removed.length;
				const text = zh
					? `OpenCode GO 模型已同步：共 ${result.total} 个，新增 ${added} 个${removed > 0 ? `，移除 ${removed} 个` : ""}。模型选择器现在即可使用全部模型。`
					: `OpenCode GO models synced: ${result.total} total, ${added} added${removed > 0 ? `, ${removed} removed` : ""}. The model picker now offers all of them.`;
				return { kind: "success", text };
			} catch (error) {
				return { kind: "error", text: error instanceof Error ? error.message : String(error) };
			}
		}
	});

	// ── self-host the browser bundle ───────────────────────────────────────
	const bundlePath = new URL("./client.js", import.meta.url);
	/** @type {Buffer|null} */
	let bundleBytes = null;
	try {
		bundleBytes = readFileSync(bundlePath);
	} catch {
		// installed without lib/client.js — routes and command still work
	}
	if (bundleBytes !== null) {
		const bytes = /** @type {Buffer} */ (bundleBytes);
		const rev = shortHash(bytes.toString("utf8"));
		const serveBundle = async (_req, res) => {
			res.setHeader("content-type", "text/javascript; charset=utf-8");
			res.setHeader("cache-control", "no-cache");
			// re-read per request so client edits land on a hard refresh
			let latest = bytes;
			try {
				latest = readFileSync(bundlePath);
			} catch {
				// startup bytes are the fallback
			}
			res.end(latest);
		};
		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: "/dsh-opencode-go-plus/client.js",
			handler: serveBundle
		}), "dsh-opencode-go-plus: client bundle route");
		ctx.effect(() => ctx.webServer.tapIndex((html) => injectGraphRow(html, {
			id: "dsh-opencode-go-plus",
			url: `/dsh-opencode-go-plus/client.js?rev=${rev}`,
			rev,
			inject: ["@deepseek-ai/dsh-client-runtime"],
			immediately: true
		})), "dsh-opencode-go-plus: boot graph injection");
	}
}
