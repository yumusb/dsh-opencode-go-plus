// @ts-check
/**
 * dsh-opencode-go-plus — account usage (the Codex-style limits view).
 *
 * The gateway answers ONE usage view per window, and it is the only trustworthy
 * statement about this account's allowance:
 *
 *   GET {wireBase}/usage        (bearer = this route's API key)
 *   { "usage": {
 *       "rolling": { "status": "ok", "percent": 1, "resetsAt": "2026-11-03T21:06:55.000Z" },
 *       "weekly":  { "status": "ok", "percent": 0, "resetsAt": "2026-11-09T00:00:00.000Z" },
 *       "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-12-03T13:15:46.000Z" } } }
 *
 * `percent` is USED, not remaining (the gateway and the console both say
 * "used"). The windows are the plan's own allowances — 5 hours = 20% of the
 * monthly limit, weekly = 50%, monthly = 100% (opencode.ai/docs/go) — so a
 * window's percent is not an absolute amount and must never be turned into one
 * locally.
 *
 * Host-free on purpose: this module takes `fetchImpl`/`now`/`timeoutMs` as
 * arguments, so parsing, the probe and the cache all run under bare `node
 * --test` without a mounted host. `index.js` owns the credential, the URL and
 * the route; this file owns the wire shape and the freshness policy.
 *
 * @module dsh-opencode-go-plus/usage
 */

/** The three windows the gateway may report, in display order. */
export const USAGE_WINDOWS = /** @type {const} */ (["rolling", "weekly", "monthly"]);

/** Ceiling for a percentage: the gateway reports 0..100, a relay may not. */
const PERCENT_MAX = 100;

/**
 * Clamp one percentage into the displayable range.
 * @param {number} value
 * @returns {number}
 */
function clampPercent(value) {
	return Math.max(0, Math.min(PERCENT_MAX, value));
}

/**
 * Parse one `/usage` payload.
 *
 * Deliberately more forgiving than a strict decoder: a window that is missing,
 * a `percent` that is not a number, or a `resetsAt` that does not parse drops
 * that FIELD, never the whole view. The page must still show the numbers it did
 * get — the alternative is an empty card because one sibling window was odd.
 * The `status` string is kept verbatim: rendering decides what it means.
 *
 * @param {unknown} payload - parsed JSON from `GET {wireBase}/usage`.
 * @returns {{ rolling?: UsageWindow, weekly?: UsageWindow, monthly?: UsageWindow } | undefined}
 *   the windows that were reported, or `undefined` when the body carries no
 *   usage envelope at all.
 */
export function parseUsage(payload) {
	const envelope = payload !== null && typeof payload === "object" && !Array.isArray(payload)
		? /** @type {Record<string, unknown>} */ (payload).usage
		: undefined;
	if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;

	/** @type {{ rolling?: UsageWindow, weekly?: UsageWindow, monthly?: UsageWindow }} */
	const windows = {};
	let sawWindow = false;
	for (const name of USAGE_WINDOWS) {
		const row = /** @type {Record<string, unknown>} */ (envelope)[name];
		if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
		const fields = /** @type {Record<string, unknown>} */ (row);
		sawWindow = true;
		/** @type {UsageWindow} */
		const window = {};
		if (typeof fields.status === "string" && fields.status.length > 0) window.status = fields.status;
		if (typeof fields.percent === "number" && Number.isFinite(fields.percent)) window.percent = clampPercent(fields.percent);
		if (typeof fields.resetsAt === "string" && Number.isFinite(Date.parse(fields.resetsAt))) window.resetsAt = fields.resetsAt;
		windows[name] = window;
	}
	return sawWindow ? windows : undefined;
}

/**
 * Strip anything that looks like the credential out of a diagnostic string.
 * The message is surfaced in the browser, so an upstream body that echoes the
 * key must not survive the trip.
 *
 * @param {unknown} error - an Error, a string, or anything printable.
 * @param {string} [secret] - the credential to scrub.
 * @returns {string}
 */
export function redactError(error, secret = "") {
	let text = error instanceof Error ? error.message : String(error ?? "");
	if (secret.length > 0) text = text.split(secret).join("[REDACTED]");
	text = text.replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]");
	text = text.trim();
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * One `GET {wireBase}/usage` probe.
 *
 * Never throws: transport failures, timeouts, non-2xx answers and bodies without
 * an usage envelope all come back as `{ ok: false, code, error }`. The caller
 * keeps the previous reading, so a probe's mood can never blank the panel.
 *
 * @param {object} input - probe inputs.
 * @param {string} input.url - absolute usage URL.
 * @param {string} input.apiKey - this route's bearer token.
 * @param {Record<string, string>} [input.headers] - attribution headers.
 * @param {number} [input.timeoutMs] - ceiling for this one request.
 * @param {typeof globalThis.fetch} [input.fetchImpl] - fetch (tests inject one).
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {Promise<UsageProbe>}
 */
export async function probeUsage({ url, apiKey, headers = {}, timeoutMs = 15000, fetchImpl = globalThis.fetch, signal }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort("usage probe timeout"), Math.max(1, timeoutMs));
	const onCallerAbort = () => controller.abort("caller aborted");
	if (signal !== undefined) {
		if (signal.aborted === true) {
			clearTimeout(timer);
			return { ok: false, code: "timeout", error: "usage probe aborted before send" };
		}
		signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { ...headers, authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal,
			redirect: "error",
			cache: "no-store"
		});
		const status = typeof response?.status === "number" ? response.status : 0;
		if (status === 401 || status === 403) {
			return { ok: false, code: "auth", error: `GET ${url} → HTTP ${status} (credential rejected)` };
		}
		if (status < 200 || status >= 300) {
			return { ok: false, code: "http", error: `GET ${url} → HTTP ${status}` };
		}
		let body;
		try {
			body = await response.json();
		} catch {
			return { ok: false, code: "shape", error: `GET ${url} answered non-JSON (HTTP ${status})` };
		}
		const windows = parseUsage(body);
		if (windows === undefined) {
			return { ok: false, code: "shape", error: `GET ${url} answered without a usage envelope` };
		}
		return { ok: true, usage: windows, fetchedAt: Date.now() };
	} catch (error) {
		const aborted = controller.signal.aborted === true;
		return {
			ok: false,
			code: aborted ? "timeout" : "network",
			error: aborted
				? `GET ${url} timed out after ${timeoutMs}ms`
				: `GET ${url} failed: ${redactError(error, apiKey)}`
		};
	} finally {
		clearTimeout(timer);
		if (signal !== undefined) signal.removeEventListener("abort", onCallerAbort);
	}
}

/**
 * The last-known usage, with a freshness window and single-flight.
 *
 * Two timestamps matter and they are deliberately separate: `attemptAt` decides
 * whether a new probe is due (a failing endpoint must not be hammered), while
 * `fetchedAt` is when the numbers on screen were actually true. A failed probe
 * therefore keeps the previous windows and reports the error beside them.
 */
export class UsageCache {
	/** @param {object} [options] - cache policy. */
	constructor({ ttlMs = 30000, now = () => Date.now() } = {}) {
		this.ttlMs = ttlMs;
		this.now = now;
		/** @type {Map<string, { windows: UsageWindows, fetchedAt: number }>} */
		this.good = new Map();
		/** @type {Map<string, UsageProbe>} */
		this.last = new Map();
		/** @type {Map<string, number>} */
		this.attemptAt = new Map();
		/** @type {Map<string, Promise<UsageProbe>>} */
		this.inFlight = new Map();
	}

	/**
	 * The last successful reading, synchronously, without probing.
	 * @param {string} key
	 */
	peek(key) {
		return this.good.get(key);
	}

	/**
	 * Read one key: serve the cached answer while it is fresh, otherwise probe
	 * once (joining any probe already running for the same key).
	 *
	 * @param {string} key - usually `apiKeyEnv|baseURL`.
	 * @param {() => Promise<UsageProbe>} loader - performs the probe.
	 * @param {{ force?: boolean, ttlMs?: number }} [options] - `force` skips the
	 *   freshness window (an explicit "refresh" action), never the in-flight join.
	 * @returns {Promise<UsageResult>}
	 */
	async read(key, loader, { force = false, ttlMs = this.ttlMs } = {}) {
		const now = this.now();
		const attemptedAt = this.attemptAt.get(key);
		const cached = this.last.get(key);
		if (force !== true && attemptedAt !== undefined && cached !== undefined && now - attemptedAt < ttlMs) {
			return { ...cached, cached: true };
		}
		const running = this.inFlight.get(key);
		if (running !== undefined) return running;

		const promise = (async () => {
			const probe = await loader();
			this.attemptAt.set(key, this.now());
			/** @type {UsageResult} */
			let result;
			if (probe.ok === true) {
				this.good.set(key, { windows: probe.usage, fetchedAt: probe.fetchedAt });
				result = { ok: true, usage: probe.usage, fetchedAt: probe.fetchedAt, cached: false };
			} else {
				const lastGood = this.good.get(key);
				result = {
					ok: false,
					code: probe.code,
					error: probe.error,
					cached: false,
					...(lastGood === undefined ? {} : { last: { windows: lastGood.windows, fetchedAt: lastGood.fetchedAt } })
				};
			}
			this.last.set(key, result);
			return result;
		})().finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, promise);
		return promise;
	}
}

/**
 * @typedef {{ status?: string, percent?: number, resetsAt?: string }} UsageWindow
 * @typedef {{ rolling?: UsageWindow, weekly?: UsageWindow, monthly?: UsageWindow }} UsageWindows
 * @typedef {{ ok: true, usage: UsageWindows, fetchedAt: number }
 *   | { ok: false, code: "auth"|"http"|"timeout"|"network"|"shape", error: string }} UsageProbe
 * @typedef {{ ok: true, usage: UsageWindows, fetchedAt: number, cached: boolean }
 *   | { ok: false, code: string, error: string, cached: boolean,
 *       last?: { windows: UsageWindows, fetchedAt: number } }} UsageResult
 */
