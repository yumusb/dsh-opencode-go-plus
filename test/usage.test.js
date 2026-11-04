import assert from "node:assert/strict";
import { test } from "node:test";

import { UsageCache, parseUsage, probeUsage, redactError } from "../lib/usage.js";

const SAMPLE = {
	usage: {
		rolling: { status: "ok", percent: 1, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "ok", percent: 0, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 0, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

// ── parseUsage ────────────────────────────────────────────────────────────

test("parseUsage keeps all three windows of a real gateway answer", () => {
	const windows = parseUsage(SAMPLE);
	assert.deepEqual(windows, {
		rolling: { status: "ok", percent: 1, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "ok", percent: 0, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 0, resetsAt: "2026-12-03T13:15:46.000Z" }
	});
});

test("parseUsage ignores an unknown window name instead of failing", () => {
	const windows = parseUsage({
		usage: {
			rolling: { status: "ok", percent: 4, resetsAt: "2026-11-03T21:06:55.000Z" },
			hourly: { status: "ok", percent: 90, resetsAt: "2026-11-03T21:06:55.000Z" }
		}
	});
	assert.deepEqual(Object.keys(windows), ["rolling"]);
});

test("parseUsage clamps a percent a relay may have sent out of range", () => {
	assert.equal(parseUsage({ usage: { rolling: { percent: 140 } } }).rolling.percent, 100);
	assert.equal(parseUsage({ usage: { rolling: { percent: -7 } } }).rolling.percent, 0);
});

test("parseUsage drops a single bad field, not the whole view", () => {
	const windows = parseUsage({
		usage: {
			rolling: { status: "ok", percent: "12", resetsAt: "not a date" },
			weekly: { status: "ok", percent: 50, resetsAt: "2026-11-09T00:00:00.000Z" }
		}
	});
	assert.deepEqual(windows.rolling, { status: "ok" });
	assert.equal(windows.weekly.percent, 50);
});

test("parseUsage keeps an unexpected status verbatim", () => {
	assert.equal(parseUsage({ usage: { monthly: { status: "rate-limited", percent: 100 } } }).monthly.status, "rate-limited");
});

test("parseUsage rejects bodies without an usage envelope", () => {
	assert.equal(parseUsage({}), undefined);
	assert.equal(parseUsage(null), undefined);
	assert.equal(parseUsage({ usage: [] }), undefined);
	assert.equal(parseUsage({ usage: {} }), undefined);
	assert.equal(parseUsage("nope"), undefined);
});

// ── probeUsage ────────────────────────────────────────────────────────────

function fakeResponse(status, body) {
	return {
		status,
		json: async () => {
			if (typeof body === "string") return JSON.parse(body);
			return body;
		}
	};
}

test("probeUsage returns the parsed windows on 200", async () => {
	let seen = null;
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "secret-key",
		headers: { "user-agent": "test" },
		fetchImpl: async (url, init) => {
			seen = { url, init };
			return fakeResponse(200, SAMPLE);
		}
	});
	assert.equal(result.ok, true);
	assert.equal(result.usage.rolling.percent, 1);
	assert.equal(typeof result.fetchedAt, "number");
	assert.equal(seen.url, "https://example.test/v1/usage");
	assert.equal(seen.init.headers.authorization, "Bearer secret-key");
	assert.equal(seen.init.headers["user-agent"], "test");
});

test("probeUsage classifies a rejected credential as auth", async () => {
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "k",
		fetchImpl: async () => fakeResponse(401, { type: "error" })
	});
	assert.equal(result.ok, false);
	assert.equal(result.code, "auth");
});

test("probeUsage classifies other non-2xx answers as http", async () => {
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "k",
		fetchImpl: async () => fakeResponse(503, {})
	});
	assert.equal(result.code, "http");
});

test("probeUsage classifies an envelope-less body as shape", async () => {
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "k",
		fetchImpl: async () => fakeResponse(200, { ok: true })
	});
	assert.equal(result.code, "shape");
});

test("probeUsage never throws: a transport failure is network", async () => {
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "k",
		fetchImpl: async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		}
	});
	assert.equal(result.code, "network");
	assert.match(result.error, /ENOTFOUND/);
});

test("probeUsage aborts at its own ceiling and reports a timeout", async () => {
	const result = await probeUsage({
		url: "https://example.test/v1/usage",
		apiKey: "k",
		timeoutMs: 20,
		fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		})
	});
	assert.equal(result.code, "timeout");
});

test("redactError scrubs the credential and any bearer token", () => {
	const text = redactError(new Error("bad key sk-abcdef123 for Bearer sk-abcdef123"), "sk-abcdef123");
	assert.doesNotMatch(text, /sk-abcdef123/);
	assert.match(text, /REDACTED/);
});

// ── UsageCache ────────────────────────────────────────────────────────────

function probe(percent) {
	return { ok: true, usage: { rolling: { status: "ok", percent } }, fetchedAt: Date.now() };
}

test("UsageCache serves a fresh answer without probing again", async () => {
	let calls = 0;
	const cache = new UsageCache({ ttlMs: 30_000, now: () => 1000 });
	const load = async () => {
		calls += 1;
		return probe(3);
	};
	const first = await cache.read("k", load);
	const second = await cache.read("k", load);
	assert.equal(calls, 1);
	assert.equal(first.cached, false);
	assert.equal(second.cached, true);
	assert.equal(second.usage.rolling.percent, 3);
});

test("UsageCache probes again once the freshness window has passed", async () => {
	let now = 0;
	let calls = 0;
	const cache = new UsageCache({ ttlMs: 1000, now: () => now });
	const load = async () => {
		calls += 1;
		return probe(calls);
	};
	await cache.read("k", load);
	now = 5000;
	await cache.read("k", load);
	assert.equal(calls, 2);
});

test("UsageCache force skips the freshness window but joins an in-flight probe", async () => {
	let calls = 0;
	const cache = new UsageCache({ ttlMs: 30_000 });
	const load = async () => {
		calls += 1;
		return probe(calls);
	};
	const a = cache.read("k", load);
	const b = cache.read("k", load, { force: true });
	await Promise.all([a, b]);
	assert.equal(calls, 1);
	await cache.read("k", load, { force: true });
	assert.equal(calls, 2);
});

test("UsageCache keeps the last good windows when a probe fails", async () => {
	let now = 0;
	const cache = new UsageCache({ ttlMs: 1000, now: () => now });
	await cache.read("k", async () => probe(42));
	now = 10_000;
	const failed = await cache.read("k", async () => ({ ok: false, code: "auth", error: "401" }));
	assert.equal(failed.ok, false);
	assert.equal(failed.code, "auth");
	assert.equal(failed.last.windows.rolling.percent, 42);
	assert.equal(cache.peek("k").windows.rolling.percent, 42);
});

test("UsageCache does not hammer a failing endpoint inside the window", async () => {
	let calls = 0;
	const cache = new UsageCache({ ttlMs: 5000, now: () => 100 });
	const load = async () => {
		calls += 1;
		return { ok: false, code: "http", error: "503" };
	};
	await cache.read("k", load);
	const second = await cache.read("k", load);
	assert.equal(calls, 1);
	assert.equal(second.cached, true);
});
