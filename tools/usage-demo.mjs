#!/usr/bin/env node
// Render the account-menu usage section to a static HTML preview.
//
// The preview is produced by the REAL component in lib/client.js — the bundle is
// loaded with stub React modules, `UsageSection` is called for each state, and a
// tiny renderer turns the element tree into HTML with inline styles. That makes
// the preview an honest picture of what the browser will draw, and it lets the
// visual be reviewed (and the layout iterated) without launching DSH.
//
//   node tools/usage-demo.mjs            # writes docs/usage-panel-demo.html
//   node tools/usage-demo.mjs <out.html>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const BUNDLE = fileURLToPath(new URL("lib/client.js", ROOT));
const OUT = process.argv[2] ?? fileURLToPath(new URL("docs/usage-panel-demo.html", ROOT));

const FRAGMENT = Symbol("Fragment");

// ── load the real bundle with stub platform modules ───────────────────────

function loadBundle() {
	const source = readFileSync(BUNDLE, "utf8");
	const entries = [];
	const react = {
		Fragment: FRAGMENT,
		useState: (initial) => [initial, () => {}],
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		useEffect: () => {},
		useRef: () => ({ current: null }),
		useCallback: (fn) => fn,
		createElement: () => null
	};
	const jsxRuntime = {
		Fragment: FRAGMENT,
		jsx: (type, props) => ({ type, props: props ?? {} }),
		jsxs: (type, props) => ({ type, props: props ?? {} })
	};
	const require = (id) => {
		if (id === "react") return react;
		if (id === "react/jsx-runtime") return jsxRuntime;
		if (id === "react-dom/client") return { createRoot: () => ({ render() {}, unmount() {} }) };
		throw new Error(`unexpected require("${id}")`);
	};
	// eslint-disable-next-line no-new-func
	new Function("window", "require", source)({ __ModuleLoader__: { load: (entry) => entries.push(entry) } }, require);
	if (entries.length !== 1) throw new Error("the bundle must register exactly one module");
	return { mod: entries[0].factory(require), react };
}

// ── tiny static renderer ──────────────────────────────────────────────────

// Unitless CSS properties (everything else gets `px` when the value is a number).
const UNITLESS = new Set([
	"opacity", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "zIndex", "order",
	"strokeWidth", "stroke-width", "fontVariantNumeric", "textUnderlineOffset"
]);

function styleOf(style) {
	if (style === null || typeof style !== "object") return "";
	return Object.entries(style)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => {
			const cssKey = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
			const cssValue = typeof value === "number" && !UNITLESS.has(key) ? `${value}px` : String(value);
			return `${cssKey}:${cssValue}`;
		})
		.join(";");
}

// React uses camelCase for SVG presentation attributes; HTML/SVG wants kebab-case.
const SVG_ATTRS = new Set([
	"strokeWidth", "strokeDasharray", "strokeOpacity", "strokeLinecap", "strokeLinejoin",
	"strokeMiterlimit", "fillOpacity", "fillRule", "clipRule", "clipPath", "colorInterpolation",
	"stopColor", "stopOpacity", "vectorEffect", "shapeRendering", "textAnchor"
]);
const svgAttribute = (key) => (SVG_ATTRS.has(key) ? key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`) : key);

function escapeHtml(text) {
	return String(text)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const VOID_TAGS = new Set(["circle", "path", "input", "br", "hr", "img"]);

function render(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return escapeHtml(node);
	if (Array.isArray(node)) return node.map(render).join("");
	if (typeof node.type === "function") return render(node.type(node.props));
	if (node.type === FRAGMENT) return render(node.props.children);

	const { props } = node;
	const tag = node.type;
	const attributes = [];
	for (const [key, value] of Object.entries(props)) {
		if (key === "children" || value === undefined || value === null || value === false) continue;
		if (key === "style") {
			const style = styleOf(value);
			if (style.length > 0) attributes.push(`style="${style}"`);
			continue;
		}
		if (key === "className") {
			if (String(value).length > 0) attributes.push(`class="${escapeHtml(value)}"`);
			continue;
		}
		if (typeof value === "function" || key === "ref") continue;
		if (key === "children") continue;
		attributes.push(`${svgAttribute(key)}="${escapeHtml(value)}"`);
	}
	const open = `<${tag}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}>`;
	if (VOID_TAGS.has(tag)) return open;
	return `${open}${render(props.children)}</${tag}>`;
}

// ── states ────────────────────────────────────────────────────────────────

const { mod, react } = loadBundle();
const zh = mod.dictionaries.zh;
const en = mod.dictionaries.en;
const t = (key) => zh[key] ?? key;
const tEn = (key) => en[key] ?? key;

/** Interpolating translator for a mock dictionary (mirrors the locale service). */
function mockTranslator(dict) {
	return (key, params) => {
		const template = dict[key] ?? key;
		if (params === undefined) return template;
		return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
	};
}

/** Long-word language: proves the label truncates before the numbers do. */
const de = {
	"usage.row": "OpenCode Go Nutzung",
	"usage.title": "Nutzungsgrenzen",
	"usage.window.rolling": "Rollierendes 5-Stunden-Fenster",
	"usage.window.weekly": "Wöchentlich",
	"usage.window.monthly": "Monatlich",
	"usage.short.rolling": "5 Std.",
	"usage.short.weekly": "Woche",
	"usage.short.monthly": "Monat",
	"usage.updatedAt": "Aktualisiert {time}",
	"usage.refresh": "Aktualisieren",
	"usage.loading": "Nutzung wird gelesen…",
	"usage.unavailable": "Nicht verfügbar",
	"usage.noKey": "Kein API-Schlüssel",
	"usage.auth": "Zugang abgelehnt",
	"usage.limited": "Limit erreicht",
	"usage.resetting": "Setzt zurück",
	"usage.hover": "Klicken für Details",
	"usage.rowAria": "{window}: {percent} verbraucht, {reset} zurückgesetzt",
	"usage.rowAriaLimited": "{window}: Limit erreicht"
};
const tDe = mockTranslator(de);

/** Right-to-left language: proves the layout mirrors instead of breaking. */
const ar = {
	"usage.row": "استهلاك OpenCode Go",
	"usage.title": "حدود الاستهلاك",
	"usage.window.rolling": "٥ ساعات",
	"usage.window.weekly": "أسبوعي",
	"usage.window.monthly": "شهري",
	"usage.short.rolling": "٥ س",
	"usage.short.weekly": "أسبوع",
	"usage.short.monthly": "شهر",
	"usage.updatedAt": "حُدِّث {time}",
	"usage.refresh": "تحديث",
	"usage.loading": "جارٍ قراءة الاستهلاك…",
	"usage.unavailable": "غير متاح",
	"usage.noKey": "لا يوجد مفتاح",
	"usage.auth": "رفضت بيانات الاعتماد",
	"usage.limited": "بلغ الحد",
	"usage.resetting": "يُعاد الضبط",
	"usage.hover": "انقر للتفاصيل",
	"usage.rowAria": "{window}: {percent} مستخدم، {reset} لإعادة الضبط",
	"usage.rowAriaLimited": "{window}: بلغ الحد"
};
const tAr = mockTranslator(ar);

const LIVE = {
	status: "ok",
	code: null,
	error: null,
	cached: false,
	fetchedAt: Date.parse("2026-11-03T16:16:00Z"),
	usage: {
		rolling: { status: "ok", percent: 20, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "ok", percent: 88, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 46, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

const LIMITED = {
	...LIVE,
	usage: {
		rolling: { status: "ok", percent: 12, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 46, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

const AUTH_ERROR = {
	status: "error",
	code: "auth",
	error: "HTTP 401",
	cached: false,
	fetchedAt: null,
	usage: null
};

const LOW = {
	...LIVE,
	usage: {
		rolling: { status: "ok", percent: 2, resetsAt: "2026-11-03T21:06:55.000Z" },
		weekly: { status: "ok", percent: 6, resetsAt: "2026-11-09T00:00:00.000Z" },
		monthly: { status: "ok", percent: 3, resetsAt: "2026-12-03T13:15:46.000Z" }
	}
};

const LOADING = { status: "loading", code: null, error: null, cached: false, fetchedAt: null, usage: null };

const CLASSES = { item: "ocgp-item", icon: "ocgp-icon", label: "ocgp-label" };

/** Render the section once with a fixed store snapshot and open/collapsed state. */
function section(state, open, options = {}) {
	const store = {
		subscribe: () => () => {},
		getSnapshot: () => state,
		read: async () => {}
	};
	const cards = mod.createCardStore();
	const translate = options.translate ?? (options.english === true ? tEn : t);
	const locale = options.locale ?? "zh-CN";
	mod.usageRingButton.reducedMotion = options.reduced === true;
	if (open) cards.toggle(options.anchor ?? null);
	const ring = render(mod.usageRingButton({ store, cards, t: translate, locale, onOpenSettings: () => {} }));
	const card = render(mod.usageCard({ store, cards, t: translate, locale }));
	mod.usageRingButton.reducedMotion = undefined;
	return { ring, card };
}

/** One sidebar mock-up: the footer row at the right end carries the ring. */
function menu({ title, note, state, open }, options = {}) {
	const mobile = options.mobile === true;
	const card = options.card === true && open ? section(state, open, options).card : "";
	return `<section class="case${mobile ? " case--mobile" : ""}">
	<header class="case-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(note)}</p></header>
	<div class="shell${mobile ? " shell--mobile" : ""}">
		<div class="sidebar">
			<div class="sessions">
				<div class="session"><span class="session-title">未分组</span></div>
				<div class="session"><span class="session-title">提示词调整</span><span class="session-time">20小时</span></div>
				<div class="session"><span class="session-title">打个招呼试试看</span><span class="session-time">18小时</span></div>
			</div>
			<div class="session remote"><span class="remote-icon">▢</span><span>Remote</span></div>
			<div class="foot">
				<span class="avatar"></span>
				<span class="account-name">余执</span>
				<span class="ring-slot">${section(state, open, options).ring}</span>
			</div>
		</div>
		${card ? `<div class="card-slot">${card}</div>` : ""}
	</div>
	</div>
</section>`;
}

const GEAR = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" stroke-linecap="round"/></svg>`;
const PLANE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.8 8l12.4-5-4.6 12-2.2-4.6z" stroke-linejoin="round"/></svg>`;
const EXIT = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M9.5 2.5h3a1 1 0 011 1v9a1 1 0 01-1 1h-3M6 8h7M10.5 5L13 8l-2.5 3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const CASES = [
	{ title: "折叠（默认）", note: "名称左、双半圆环右：上弧 5 小时（20%），下弧一周（88%），中心是 OpenCode 标志；单色，只有弧长说话；悬停某半弧出「20% 5h」", state: LIVE, open: false },
	{ title: "折叠：用量很低", note: "弧长即用量；全程单色（跟随文字的次要色），不抢注意力", state: LOW, open: false },
	{ card: true, title: "展开：三个窗口", note: "点一下从菜单右侧浮出卡片（预览里内联展示便于对比）：三窗口 + 「更新于」+ 右上角控制台图标", state: LIVE, open: true },
	{ card: true, title: "展开：只有「每周」到顶", note: "限额只出现在它自己那一行（替换重置时间），环降为灰显——「用完」而不是「报警」", state: LIMITED, open: true },
	{ card: true, title: "展开：凭据无效", note: "失败不瞎编：没有数字就只写状态，并给一个「去插件设置填写」的出口", state: AUTH_ERROR, open: true },
	{ card: true, title: "展开：读取中", note: "首次打开、尚未拿到数据", state: LOADING, open: true }
];

const PHONE_CASES = [
	{ title: "手机 · 折叠", note: "390px 视口、260px 菜单：名称不换行，读数靠右", state: LIVE, open: false },
	{ card: true, title: "手机 · 展开（中文）", note: "标签 / 百分比 / 时间仍在一条线上", state: LIVE, open: true },
	{ title: "手机 · 英文", note: "Weekly / Monthly 更长，仍不挤掉数字", state: LIVE, open: true, english: true, locale: "en-US" },
	{ title: "手机 · 长词语言（德）", note: "标签该截断就截断；百分比与时间永不截断", state: LIVE, open: true, translate: tDe, locale: "de-DE" },
	{ title: "手机 · 从右到左（阿）", note: "RTL 语言：标签镜像、数字仍在自己的列里", state: LIMITED, open: true, translate: tAr, locale: "ar-EG" }
];

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode Go 用量 · 账号菜单预览</title>
<style>
	/* A stand-in for the DSH shell: the same theme tokens, both colour schemes,
	   so the inline styles in the component resolve exactly as they would there. */
	:root {
		color-scheme: dark;
		--dsw-alias-bg-base: #17171a;
		--dsw-alias-bg-layer-1: #232327;
		--dsw-alias-bg-layer-2: rgba(255, 255, 255, 0.055);
		--dsw-alias-bg-overlay: #2b2b31;
		--dsw-alias-border-l1: rgba(255, 255, 255, 0.12);
		--dsw-alias-label-primary: #ececf1;
		--dsw-alias-label-secondary: #9b9ba4;
		--dsw-alias-state-success-primary: #3fbe8a;
		--dsw-alias-state-warn-primary: #d9a441;
		--dsw-alias-state-error-primary: #e06b6b;
		--dsw-specific-sidebar-fill: #1e1e22;
	}
	html[data-theme="light"] {
		color-scheme: light;
		--dsw-alias-bg-base: #f6f6f7;
		--dsw-alias-bg-layer-1: #ffffff;
		--dsw-alias-bg-layer-2: rgba(0, 0, 0, 0.045);
		--dsw-alias-bg-overlay: #ffffff;
		--dsw-alias-border-l1: rgba(0, 0, 0, 0.1);
		--dsw-alias-label-primary: #1d1d20;
		--dsw-alias-label-secondary: #6b6b74;
		--dsw-alias-state-success-primary: #22a06b;
		--dsw-alias-state-warn-primary: #b7791f;
		--dsw-alias-state-error-primary: #c94444;
		--dsw-specific-sidebar-fill: #ededee;
	}
	html {
		font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
	}
	html[data-theme="light"] .menu { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12); }
	.theme-toggle { position: fixed; top: 18px; right: 20px; padding: 6px 10px; border-radius: 8px;
		border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
		color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
	body { margin: 0; padding: 28px 28px 40px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
	h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
	.lede { margin: 0 0 24px; font-size: 13px; color: var(--dsw-alias-label-secondary); max-width: 780px; line-height: 1.65; }
	code { font-size: 12px; }
	.grid { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
	.case { width: 580px; }
	.case-head h2 { font-size: 13px; font-weight: 600; margin: 0 0 3px; }
	.case-head p { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin: 0 0 10px; line-height: 1.5; min-height: 34px; }
	.shell { position: relative; background: transparent; border: 0; padding: 0; }
	.menu {
		background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
		border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 2px;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
	}
	.ocgp-item {
		box-sizing: border-box;
		display: flex; align-items: center; gap: 8px; width: 100%;
		padding: 8px 9px; border: 0; border-radius: 7px; background: transparent;
		color: var(--dsw-alias-label-primary); font: inherit; font-size: 13.5px; line-height: 1.35;
		text-align: left; cursor: pointer;
	}
	.ocgp-item:hover { background: rgba(127, 127, 127, 0.16); }
	.ocgp-icon { display: inline-flex; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); flex: none; }
	.ocgp-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.hint { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
	.divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 5px 4px; }
	.account { display: flex; align-items: center; gap: 9px; padding: 10px 6px 0; }
	.avatar { width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(140deg, #f0b27a, #b06a3b); }
	.account-name { font-size: 13.5px; }
	.sidebar { position: relative; display: flex; flex-direction: column; gap: 2px; min-height: 260px;
		background: var(--dsw-specific-sidebar-fill); border-radius: 10px; padding: 8px 0 4px; }
	.sessions { display: flex; flex-direction: column; gap: 2px; flex: 1; padding: 6px 8px; }
	.session { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; font-size: 12.5px;
		color: var(--dsw-alias-label-secondary); }
	.session-title { color: var(--dsw-alias-label-primary); }
	.session-time { margin-left: auto; font-size: 11px; }
	.session.remote { padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
	.remote-icon { opacity: .7; }
	.foot { display: flex; align-items: center; gap: 9px; padding: 8px 10px 10px; }
	.ring-slot { display: inline-flex; align-items: center; margin-left: auto; padding-left: 8px; }
	.card-slot { position: absolute; left: 276px; top: 26px; }
	.section-title { font-size: 14px; font-weight: 600; margin: 34px 0 4px; }
	.lede--tight { margin-bottom: 16px; max-width: 680px; }
	.grid--phone { gap: 20px; }
	.case--mobile { width: 420px; }
	.case--mobile .ocgp-item { box-sizing: border-box; }
	.shell--mobile { padding: 10px 8px 12px; }
	.sidebar { width: 260px; box-sizing: border-box; }
</style>
</head>
<body>
	<h1>OpenCode Go 用量 · 账号菜单预览</h1>
	<p class="lede">
		这个页面由 <code>tools/usage-demo.mjs</code> 用插件真实的 <code>UsageSection</code> 组件渲染成静态 HTML
		（样式全部内联，跟随 <code>--dsw-alias-*</code> 主题变量，深色/浅色都生效）。
		改完 <code>lib/client.js</code> 重新跑一次即可对照；它不是手工画的原型，所以看到的布局就是浏览器里会画的布局。
	</p>
	<div class="grid">${CASES.map((entry) => menu(entry, { card: entry.card === true })).join("")}</div>

	<h2 class="section-title">手机宽度（390px）：菜单被挤窄时的样子</h2>
	<p class="lede lede--tight">
		DSH 的 Web shell 没有宽度断点，手机上是"整块桌面布局被挤窄"。这里按 390px 视口 + 260px 菜单渲染同一组件，
		检查标签截断、百分比与时间是否还在一行、以及触屏下刷新图标是否可见。
	</p>
	<div class="grid grid--phone">${PHONE_CASES.map((entry) => menu(entry, { mobile: true, card: entry.card === true, english: entry.english === true, locale: entry.locale, translate: entry.translate })).join("")}</div>
	<button class="theme-toggle" type="button" id="theme-toggle">切换深色 / 浅色</button>
	<script>
		// ?theme=light (or dark) picks a scheme for screenshots; the button flips it.
		const params = new URLSearchParams(location.search);
		if (params.get("theme") === "light" || params.get("theme") === "dark") {
			document.documentElement.dataset.theme = params.get("theme");
		}
		document.getElementById("theme-toggle").addEventListener("click", () => {
			const root = document.documentElement;
			root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
		});
	</script>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${html.length} bytes)`);
