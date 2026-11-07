// @ts-check
/**
 * dsh-opencode-go-plus — plan usage (host half).
 *
 * OpenCode GO reports the subscription's quota on the same gateway that serves
 * the models: `GET {gateway}/v1/usage`, authenticated with the same API key.
 * The response is one object per rolling window:
 *
 *   { "usage": {
 *       "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-08-14T07:51:13Z" },
 *       "weekly":  { "status": "ok", "percent": 4,  "resetsAt": "2026-08-17T00:00:00Z" },
 *       "monthly": { "status": "ok", "percent": 22, "resetsAt": "2026-08-21T13:05:13Z" }
 *   } }
 *
 * The browser never sees the key: the host proxies one read per cache window,
 * so several open tabs cannot hammer the gateway. Percentages are the
 * gateway's own numbers — quota arithmetic stays upstream — and a window
 * without a usable percentage is dropped rather than drawn as a misleading 0%.
 *
 * @module dsh-opencode-go-plus/usage
 */

/** Path of the quota endpoint, relative to the wire base (which carries `/v1`). */
export const USAGE_PATH = "/usage";

/**
 * Window ids in reset-cadence order: the shortest window first, the monthly
 * pool last (it resets with the billing period).
 */
export const WINDOW_ORDER = Object.freeze(["rolling", "weekly", "monthly"]);

/**
 * The quota URL for a configured gateway base.
 *
 * `baseURL` is stored without a version segment by default
 * (`https://opencode.ai/zen/go`) but users may paste the wire base with one
 * (`.../v1`), exactly like the chat paths accept both — so the segment is
 * normalized here, not appended blindly.
 * @param {string} baseURL
 * @returns {string}
 */
export function usageEndpoint(baseURL) {
	const base = String(baseURL ?? "").replace(/\/+$/, "");
	const versioned = /\/v\d+$/.test(base) ? base : `${base}/v1`;
	return `${versioned}${USAGE_PATH}`;
}

/**
 * A percentage the UI can draw: finite, clamped to 0..100, at most two
 * decimals so a float from a relay does not leak `33.333333%` into a label.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function usablePercent(value) {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return undefined;
	return Math.round(Math.max(0, Math.min(100, parsed)) * 100) / 100;
}

/**
 * A reset instant, accepting the ISO strings the gateway sends as well as
 * Unix seconds/milliseconds from older shapes. `resetsAt: 0` means "no reset
 * scheduled" (a window that has not started), which is not the epoch.
 * @param {unknown} value
 * @returns {string|null}
 */
function resetInstant(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return null;
		return new Date(value < 1e11 ? value * 1000 : value).toISOString();
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
	}
	return null;
}

/**
 * Normalize the gateway payload into the only shape the browser draws:
 * `windows: [{ id, label, percent, status, resetsAt }]`, known windows first
 * (rolling → weekly → monthly) and any window a future gateway adds appended,
 * so a new quota window appears without a plugin release.
 *
 * The `usage` envelope is unwrapped when present, but a bare window map is
 * accepted too — that is what the same endpoint returned in earlier builds.
 * @param {unknown} payload
 * @returns {{ windows: Array<{ id: string, label: string, percent: number, status: string|null, resetsAt: string|null }> }}
 */
export function normalizeUsagePayload(payload) {
	const source = payload !== null && typeof payload === "object"
		? /** @type {Record<string, unknown>} */ (payload)
		: {};
	const raw = source.usage !== null && typeof source.usage === "object" && !Array.isArray(source.usage)
		? /** @type {Record<string, unknown>} */ (source.usage)
		: source;
	/** @type {Array<{ id: string, label: string, percent: number, status: string|null, resetsAt: string|null }>} */
	const windows = [];
	const seen = new Set();
	/** @param {string} id @param {unknown} value */
	const collect = (id, value) => {
		if (seen.has(id)) return;
		seen.add(id);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
		const window = /** @type {Record<string, unknown>} */ (value);
		const percent = usablePercent(window.percent);
		// A window without a limit has nothing to draw: dropping it is honest,
		// showing 0% would claim the quota is untouched.
		if (percent === undefined) return;
		windows.push({
			id,
			label: typeof window.label === "string" && window.label.length > 0 ? window.label : id,
			percent,
			status: typeof window.status === "string" && window.status.length > 0 ? window.status : null,
			resetsAt: resetInstant(window.resetsAt)
		});
	};
	for (const id of WINDOW_ORDER) collect(id, raw[id]);
	for (const [id, value] of Object.entries(raw)) {
		if (!WINDOW_ORDER.includes(id)) collect(id, value);
	}
	return { windows };
}

/**
 * An error carrying the upstream status and the coarse kind the route maps to
 * an HTTP status, so the widget can distinguish a bad key from a plan problem
 * from a generic outage.
 * @param {number} status
 * @param {"auth"|"entitlement"|"upstream"|"shape"} kind
 * @param {string} message
 */
function usageError(status, kind, message) {
	const error = /** @type {Error & { status?: number, kind?: string }} */ (new Error(message));
	error.status = status;
	error.kind = kind;
	return error;
}

/**
 * Read the plan quota for one credential.
 *
 * Every failure is reported as an Error carrying `status`/`kind`; the route
 * turns that into an HTTP status and the card shows the message. The raw
 * payload is never trusted to be the documented shape: an unexpected body is
 * reported as a gateway problem instead of drawing an empty widget.
 *
 * @param {object} input
 * @param {string} input.baseURL - configured gateway base.
 * @param {string} input.apiKey
 * @param {number} [input.timeoutMs]
 * @param {typeof fetch} [input.fetchImpl] - injectable for tests.
 * @returns {Promise<{ ok: true, windows: Array<{ id: string, label: string, percent: number, status: string|null, resetsAt: string|null }> }>}
 */
export async function fetchPlanUsage({ baseURL, apiKey, timeoutMs = 15000, fetchImpl = fetch }) {
	const url = usageEndpoint(baseURL);
	let res;
	try {
		res = await fetchImpl(url, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		throw usageError(0, "upstream", `usage request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		let detail = body.slice(0, 200);
		try {
			const parsed = JSON.parse(body);
			if (typeof parsed?.error?.message === "string" && parsed.error.message.length > 0) detail = parsed.error.message;
		} catch {
			// non-JSON body — keep the raw excerpt
		}
		if (res.status === 401) throw usageError(401, "auth", "the gateway rejected the credential (HTTP 401)");
		if (res.status === 403) throw usageError(403, "entitlement", "no active OpenCode GO plan on this account (HTTP 403)");
		throw usageError(res.status, "upstream", `usage gateway error (HTTP ${res.status})${detail.length > 0 ? `: ${detail}` : ""}`);
	}
	const payload = await res.json().catch(() => null);
	const view = normalizeUsagePayload(payload);
	if (view.windows.length === 0) {
		throw usageError(0, "shape", "the gateway returned no usable usage windows");
	}
	return { ok: true, ...view };
}
