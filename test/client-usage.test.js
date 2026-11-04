import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The client half is a hand-authored module-loader bundle: it calls
// `window.__ModuleLoader__.load({ factory })` and builds its exports inside the
// factory. Loading it here with stub modules is the only way to test the parts
// of it that are pure (formatting, dictionaries, rendered tree) without a DOM.
const BUNDLE = new URL("../lib/client.js", import.meta.url);

function loadBundle() {
	const source = readFileSync(BUNDLE, "utf8");
	const entries = [];
	const FRAGMENT = Symbol("Fragment");
	const fakeWindow = { __ModuleLoader__: { load: (entry) => entries.push(entry) }, open: () => null };
	const record = (type, props) => ({ type, props: props ?? {} });
	const fakeRequire = (id) => {
		switch (id) {
			case "react":
				return {
					Fragment: FRAGMENT,
					useState: (initial) => [initial, () => {}],
					useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
					useEffect: () => {},
					useRef: (initial) => ({ current: initial ?? null }),
					useCallback: (fn) => fn,
					createElement: () => null
				};
			case "react/jsx-runtime":
				return { Fragment: FRAGMENT, jsx: record, jsxs: record };
			case "react-dom/client":
				return { createRoot: () => ({ render() {}, unmount() {} }) };
			default:
				throw new Error(`unexpected require("${id}") from the client bundle`);
		}
	};
	// eslint-disable-next-line no-new-func
	new Function("window", "require", source)(fakeWindow, fakeRequire);
	assert.equal(entries.length, 1, "the bundle registers exactly one module");
	assert.equal(entries[0].id, "dsh-opencode-go-plus");
	return { mod: entries[0].factory(fakeRequire), fakeWindow };
}

const { mod, fakeWindow } = loadBundle();

function translator(dict) {
	return (key, params) => {
		const template = dict[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
	};
}
const tr = translator(mod.dictionaries.zh);
const trEn = translator(mod.dictionaries.en);

/** Walk a recorded tree; React flattens children arrays and calls components. */
function walk(node, visit) {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (node === null || typeof node !== "object") return;
	if (typeof node.type === "function") {
		walk(node.type(node.props), visit);
		return;
	}
	if (node.props === undefined) return;
	visit(node);
	walk(node.props.children, visit);
}

const nodesWhere = (tree, predicate) => {
	const found = [];
	walk(tree, (node) => {
		if (predicate(node)) found.push(node);
	});
	return found;
};

const textsOf = (tree) => {
	const texts = [];
	walk(tree, (node) => {
		const children = node.props.children;
		if (typeof children === "string" || typeof children === "number") texts.push(String(children));
	});
	return texts;
};

const ANCHOR = { left: 24, bottom: 120 };

function harness(state, { open = false, anchor = ANCHOR } = {}) {
	const store = { subscribe: () => () => {}, getSnapshot: () => state, read: async () => {} };
	const cards = mod.createCardStore();
	if (open) cards.toggle(anchor);
	return { store, cards };
}

function renderRing(state, { locale = "en-US", reduced = false, translate = tr, open = false, onOpenSettings } = {}) {
	const { store, cards } = harness(state, { open });
	mod.usageRingButton.reducedMotion = reduced;
	const tree = mod.usageRingButton({ store, cards, t: translate, locale, onOpenSettings });
	mod.usageRingButton.reducedMotion = undefined;
	return tree;
}

function renderCard(state, { locale = "en-US", translate = tr, anchor = ANCHOR, open = true } = {}) {
	const { store, cards } = harness(state, { open, anchor });
	return mod.usageCard({ store, cards, t: translate, locale });
}

const LIVE = {
	status: "ok",
	code: null,
	error: null,
	cached: false,
	fetchedAt: Date.parse("2026-11-04T05:16:00.000Z"),
	usage: {
		rolling: { status: "ok", percent: 20, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "ok", percent: 88, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 46, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

const SPENT = {
	...LIVE,
	usage: {
		rolling: { status: "ok", percent: 12, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 46, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

const NO_KEY = { status: "error", code: "no-key", error: "no key", cached: false, fetchedAt: null, usage: null };

// ── helpers ───────────────────────────────────────────────────────────────

test("the bundle exposes the ring, the card and the formatting helpers", () => {
	assert.equal(typeof mod.usageRingButton, "function");
	assert.equal(typeof mod.usageCard, "function");
	assert.equal(typeof mod.createCardStore, "function");
	for (const name of ["formatPercent", "usageWindows", "formatResetValue", "formatUpdatedAt", "hoverReading", "usageSummary"]) {
		assert.equal(typeof mod.usageFormat[name], "function", name);
	}
	assert.deepEqual(mod.usageFormat.USAGE_WINDOWS, ["rolling", "weekly", "monthly"]);
});

test("formatPercent never invents a number", () => {
	const { formatPercent } = mod.usageFormat;
	assert.equal(formatPercent(20), "20%");
	assert.equal(formatPercent(140), "100%");
	assert.equal(formatPercent(-4), "0%");
	assert.equal(formatPercent(undefined), "—");
});

test("usageWindows keeps the documented order and appends unknown windows", () => {
	const { usageWindows } = mod.usageFormat;
	assert.deepEqual(usageWindows(LIVE.usage), ["rolling", "weekly", "monthly"]);
	assert.deepEqual(usageWindows({ rolling: { percent: 1 }, daily: { percent: 9 } }), ["rolling", "daily"]);
	assert.deepEqual(usageWindows(undefined), []);
});

test("Intl owns the time formats", () => {
	const { formatResetValue, formatUpdatedAt } = mod.usageFormat;
	const now = Date.parse("2026-11-04T05:16:00.000Z");
	const soon = new Date(now + 3 * 3600 * 1000).toISOString();
	const far = new Date(now + 5 * 24 * 3600 * 1000).toISOString();
	assert.equal(
		formatResetValue(soon, now, "en-US", trEn),
		new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(new Date(soon))
	);
	assert.equal(
		formatResetValue(far, now, "en-US", trEn),
		new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(far))
	);
	assert.equal(formatResetValue(soon, now + 10 * 3600 * 1000, "en-US", trEn), "Resetting");
	assert.equal(formatUpdatedAt(now, "en-US"), new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(new Date(now)));
	assert.equal(formatUpdatedAt(null, "en-US"), null);
});

test("hoverReading is the ring's tooltip: percent first, unit second", () => {
	const { hoverReading } = mod.usageFormat;
	assert.equal(hoverReading("rolling", 20, 88, tr), "80% 5h");
	assert.equal(hoverReading("weekly", 20, 88, trEn), "12% wk");
});

test("the dictionaries stay balanced and cover the ring's copy", () => {
	const { zh, en } = mod.dictionaries;
	assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	for (const key of ["usage.title", "usage.connect", "usage.console", "usage.limited", "usage.updatedAt", "usage.percentAria"]) {
		assert.equal(typeof zh[key], "string", `zh.${key}`);
		assert.equal(typeof en[key], "string", `en.${key}`);
	}
});

// ── ring ──────────────────────────────────────────────────────────────────

test("the ring is two monochrome arcs with the mark in the hole", () => {
	const ring = nodesWhere(renderRing(LIVE), (node) => node.props["data-ocgp"] === "usage-ring");
	assert.equal(ring.length, 1);
	const paths = nodesWhere(ring[0], (node) => node.type === "path");
	assert.equal(paths.length, 6, "per half: track + progress + hit twin");
	const progress = paths.filter((node) => node.props.pathLength === 100);
	assert.equal(progress[0].props.strokeDasharray, "80 100");
	assert.equal(progress[1].props.strokeDasharray, "12 100");
	assert.equal(progress[0].props.stroke, "currentColor", "no hue: the arc length is the reading");
	assert.equal(progress[1].props.stroke, "currentColor");
	assert.match(String(paths[0].props.d), /^M4\.4 13\.1 A12 12 0 0 1 27\.6 13\.1$/, "top arc leaves a 14-degree gap at each seam");
	const marks = nodesWhere(ring[0], (node) => node.type === "g" && typeof node.props.transform === "string");
	assert.equal(marks[0].props.transform, "translate(10 10) scale(0.75)");
});

test("a spent window desaturates the ring instead of colouring it", () => {
	const tree = renderRing(SPENT);
	const button = nodesWhere(tree, (node) => node.props["data-ocgp"] === "usage-ring-button")[0];
	assert.equal(button.props["data-state"], "empty");
	assert.ok(Number(button.props.style.opacity) < 1, "empty is muted, never an alarm");
	assert.equal(nodesWhere(tree, (node) => node.props.pathLength === 100).length, 0, "no progress arcs at all");
	assert.equal(nodesWhere(tree, (node) => node.type === "path")[0].props.strokeDasharray, "2 4", "the track is dashed instead");
});

test("the ring is one disclosure button carrying the summary as its name", () => {
	const closed = nodesWhere(renderRing(LIVE), (node) => node.props["data-ocgp"] === "usage-ring-button")[0];
	assert.equal(closed.props["aria-expanded"], false);
	assert.equal(closed.props["aria-controls"], "ocgp-usage-card");
	assert.match(String(closed.props["aria-label"]), /5h 80%/);
	const opened = nodesWhere(renderRing(LIVE, { open: true }), (node) => node.props["data-ocgp"] === "usage-ring-button")[0];
	assert.equal(opened.props["aria-expanded"], true);
});

test("no credential turns the ring into a one-hop setup control", () => {
	const seen = [];
	const tree = renderRing(NO_KEY, { onOpenSettings: () => seen.push("settings") });
	const button = nodesWhere(tree, (node) => node.props["data-ocgp"] === "usage-ring-button")[0];
	assert.equal(button.props["data-state"], "unconfigured");
	assert.equal(button.props.title, "未配置 API Key · 去插件设置");
	assert.equal(button.props["aria-expanded"], undefined, "there is nothing to expand");
	button.props.onClick({ preventDefault() {}, stopPropagation() {} });
	assert.deepEqual(seen, ["settings"], "the click goes straight to the plugin settings card");
	assert.equal(nodesWhere(tree, (node) => node.props["data-ocgp"] === "usage-card").length, 0, "no dead-end card");
});

test("reduced motion turns the arc's hover transition off", () => {
	const arcOf = (tree) => nodesWhere(tree, (node) => node.props.pathLength === 100)[0];
	assert.match(String(arcOf(renderRing(LIVE, { reduced: false })).props.style.transition), /stroke-width/);
	assert.equal(arcOf(renderRing(LIVE, { reduced: true })).props.style.transition, "none");
});

// ── card ──────────────────────────────────────────────────────────────────

test("the card lists the three windows and the console shortcut", () => {
	const card = nodesWhere(renderCard(LIVE), (node) => node.props["data-ocgp"] === "usage-card")[0];
	assert.ok(card);
	const rows = nodesWhere(card, (node) => node.props["data-window"] !== undefined);
	assert.deepEqual(rows.map((row) => row.props["data-window"]), ["rolling", "weekly", "monthly"]);
	const grid = nodesWhere(card, (node) => node.props["data-ocgp"] === "usage-grid")[0];
	assert.equal(grid.props.style.gridTemplateColumns, "minmax(0, 1fr) auto auto");

	const button = nodesWhere(card, (node) => node.props["data-ocgp"] === "usage-console")[0];
	assert.equal(button.props["aria-label"], "在控制台打开");
	const calls = [];
	const original = fakeWindow.open;
	fakeWindow.open = (...args) => calls.push(args);
	try {
		button.props.onClick({ preventDefault() {}, stopPropagation() {} });
	} finally {
		fakeWindow.open = original;
	}
	assert.deepEqual(calls[0].slice(0, 2), ["https://opencode.ai/console/", "_blank"]);
});

test("the card is anchored above the ring and stays in flow without an anchor", () => {
	const card = nodesWhere(renderCard(LIVE), (node) => node.props["data-ocgp"] === "usage-card")[0];
	assert.equal(card.props.style.position, "fixed");
	assert.equal(card.props.style.bottom, 120);
	assert.equal(card.props.style.left, 24);
	const plain = nodesWhere(renderCard(LIVE, { anchor: null }), (node) => node.props["data-ocgp"] === "usage-card")[0];
	assert.equal(plain.props.style.position, "static");
	assert.equal(nodesWhere(renderCard(LIVE, { open: false }), (node) => node.props["data-ocgp"] === "usage-card").length, 0);
});

test("a spent window says so in its own row", () => {
	const rows = nodesWhere(renderCard(SPENT), (node) => node.props["data-window"] !== undefined);
	const spent = rows.filter((row) => row.props["data-state"] === "limited");
	assert.equal(spent.length, 1);
	assert.equal(spent[0].props["data-window"], "weekly");
	assert.equal(spent[0].props.children[2].props.children, "已达限额");
});

test("the card reports freshness and names failures", () => {
	const foot = nodesWhere(renderCard(LIVE), (node) => node.props["data-ocgp"] === "usage-freshness")[0];
	assert.match(textsOf(foot).join(""), /^更新于 /);
	const failed = renderCard(NO_KEY);
	assert.match(textsOf(failed).join(" | "), /未配置 API Key/);
	assert.equal(nodesWhere(failed, (node) => node.props["data-window"] !== undefined).length, 0);
});

test("the card wears the shipped menu material, not a hand-mixed surface", () => {
	const card = nodesWhere(renderCard(LIVE), (node) => node.props["data-ocgp"] === "usage-card")[0];
	// shell: DSH radius / hairline border / elevation token
	assert.match(String(card.props.style.borderRadius), /--dsw-radius-lg/);
	assert.match(String(card.props.style.border), /--dsw-alias-border-l3/);
	assert.match(String(card.props.style.boxShadow), /--dsw-shadow-lv3/);
	// surface: the same fill + backdrop blur the menus use
	const material = nodesWhere(card, (node) => node.props["data-ocgp"] === "usage-material")[0];
	assert.ok(material, "the surface is an inset layer (inline styles cannot use ::before)");
	assert.match(String(material.props.style.background), /--dsw-menu-surface-fill/);
	assert.match(String(material.props.style.backdropFilter), /--dsw-menu-backdrop-filter/);
	assert.equal(material.props.style.borderRadius, "inherit");
});

test("the card anchors above the ring and stays inside the viewport at every width", () => {
	const { cardAnchor } = mod.usageFormat;
	const CARD = 248;
	const CARD_HEIGHT = 132;
	for (const width of [1024, 1440, 1920]) {
		const height = 800;
		// the ring sits at the sidebar foot: x 220..260, vertically at y 700..740
		const ring = { left: 220, right: 260, top: 700, bottom: 740 };
		const anchor = cardAnchor(ring, { width, height }, CARD);
		assert.ok(anchor.left >= 8, width + ": not clipped on the left");
		assert.ok(anchor.left + CARD <= width - 8, width + ": not clipped on the right");
		// bottom is measured from the viewport's bottom edge, so this is "above the ring"
		assert.equal(anchor.bottom, height - ring.top + 6, width + ": card bottom sits just above the ring");
		const cardTop = height - anchor.bottom - CARD_HEIGHT;
		assert.ok(cardTop < ring.top, width + ": the card never covers the ring");
	}
	// a ring hugging the right edge still yields a fully visible card
	const edge = cardAnchor({ left: 1180, right: 1220, top: 700, bottom: 740 }, { width: 1024, height: 800 }, CARD);
	assert.ok(edge.left + CARD <= 1024 - 8, "clamped into the viewport");
});

test("the ring's band rule: no intersection, centred, clear of the name", () => {
	const { ringPlacement } = mod.usageFormat;
	const row = { left: 12, top: 700, right: 232, bottom: 748, width: 220, height: 48 };
	// the shipped layout: ring at the row's right end, vertically centred
	const good = ringPlacement(row, { left: 240, top: 704, right: 280, bottom: 744, width: 40, height: 40 });
	assert.equal(good.overlap, false);
	assert.equal(good.dy, 0);
	assert.ok(good.dx >= 8, "at least 8px of air after the name");
	// the failure that kept happening: the ring drawn on top of the row
	const onTop = ringPlacement(row, { left: 196, top: 704, right: 236, bottom: 744, width: 40, height: 40 });
	assert.equal(onTop.overlap, true, "overlap must be detected, not painted over");
	// the other failure: a different band
	const offBand = ringPlacement(row, { left: 240, top: 660, right: 280, bottom: 700, width: 40, height: 40 });
	assert.equal(offBand.overlap, false);
	assert.ok(offBand.dy > 2, "a 40px offset is off the band");
});

// ── plugin surface ────────────────────────────────────────────────────────

test("apply mounts the sidebar ring through ctx.effect", () => {
	const seen = [];
	const ctx = {
		effect: (factory, label) => {
			seen.push(String(label ?? ""));
			const cleanup = factory();
			return typeof cleanup === "function" ? cleanup : () => {};
		},
		locale: { register: () => () => {}, bind: () => (key) => key, getLocale: () => ({ active: "zh-CN" }) },
		slots: { inject: () => () => {}, register: () => () => {} },
		get: () => undefined
	};
	mod.apply(ctx);
	assert.match(seen.join("\n"), /dictionaries/);
	assert.match(seen.join("\n"), /sidebar usage ring/);
});
