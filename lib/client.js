// dsh-opencode-go-plus — browser half.
//
// Hand-authored client bundle in the DSH module-loader factory format:
// `window.__ModuleLoader__.load({ id, factory })`. The factory receives the
// module-table `require`, so only shell-externalized modules may be imported
// (react / react/jsx-runtime are in the static table).
//
// One card in Settings → Plugins → Plugin configuration owns the whole
// integration:
//   - connection: gateway baseURL and the API key (written to the credentials
//     seam host-side, never kept in the browser) plus a live test call;
//   - models: fetch the gateway list, pick which to enable, apply. Applying an
//     empty pick is legal and disables every model.
// The stored key value never returns to the browser: the card only learns
// whether one is configured.
window.__ModuleLoader__.load({
	id: "dsh-opencode-go-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		// A second React root is how the account-menu usage section renders inside
		// the shipped menu without touching that menu's own React tree. Guarded: a
		// missing platform module must not take the settings card down with it.
		let react_dom_client = null;
		try {
			react_dom_client = require("react-dom/client");
		} catch {
			react_dom_client = null;
		}

		// ── locale dictionaries ──
		// Registered with DSH's own locale service, so the card follows the same
		// language as the rest of the harness. `bind(ns)` returns a live
		// translate function that reads the active locale at call time.
		const NS = "dsh-opencode-go-plus";
		const zh = {
			"cap.context": "{value} 上下文",
			"cap.output": "{value} 输出",
			"cap.image": "图文",
			"save.failed": "保存失败：{msg}",
			"save.ok": "已保存。网关 {url}{key}",
			"save.keySet": "，密钥已配置",
			"save.keyUnset": "，尚未配置密钥",
			"test.failed": "连接失败：{msg}",
			"test.api.anthropic": "Anthropic 协议",
			"test.api.openai": "OpenAI 协议",
			"test.api.responses": "OpenAI Responses 协议",
			"test.ok": "连接正常：凭据有效 · {summary} · {ms} ms",
			"test.blocked": " · 但 {detail}",
			"test.unsaved": " · 测的是输入框里的值，尚未保存",
			"test.passed": "已通过",
			"fetch.failed": "获取失败：{msg}",
			"fetch.empty": "网关没有返回任何模型",
			"apply.failed": "应用失败：{msg}",
			"apply.none": "已停用全部模型，模型选择器中将不再显示。",
			"apply.ok": "已启用 {n} 个模型。",
			"title.loading": "读取中…",
			"title.count": "{n} 个模型已启用",
			"desc": "连接 OpenCode GO 网关，并选择要在此使用的模型。",
			"field.baseUrl": "网关地址",
			"key.configured": "密钥已配置",
			"key.unconfigured": "未配置密钥",
			"key.placeholderSet": "已配置，留空则不修改",
			"key.placeholderNew": "粘贴 API 密钥",
			"key.label": "API 密钥",
			"btn.saving": "保存中…",
			"btn.save": "保存",
			"btn.testing": "测试中…",
			"btn.test": "测试连接",
			"conn.hint": "保存会把上面的值写入配置；测试连接直接测输入框里的值，不必先保存。",
			"models.loading": "正在读取模型配置…",
			"models.all": "尚未固定模型清单，当前提供全部可用模型。",
			"models.selected": "当前仅提供所选模型；取消全部勾选即可停用。",
			"models.via": "候选来源：{url}",
			"models.stale": "以下模型已下线：{ids}",
			"models.undocumented": "以下模型目录已不再收录，可能已下线：{ids}",
			"btn.checking": "检查中…",
			"btn.check": "检查模型可用性",
			"check.ok": "已检查 {n} 个模型，全部可用 · {ms} ms",
			"check.blocked": " · 另有被政策或地区限制的：{ids}",
			"check.unavailable": "以下模型网关仍在列出，但提供方已不再提供：{ids}（已检查 {n} 个 · {ms} ms）",
			"check.failed": "检查失败：{msg}",
			"check.removed": "已移除并保存：{ids}（现在启用 {n} 个）",
			"check.dirty": "当前有未应用的改动，请先点「启用所选」或「放弃改动」，再移除这些模型。",
			"check.drop": "移除这些模型并保存",
			"row.undocumented": "目录未收录",
			"btn.fetching": "获取中…",
			"btn.refetch": "重新获取",
			"search.placeholder": "搜索模型",
			"count": "已选 {picked} / {total}",
			"count.visible": "已选 {picked} / {total} · 显示 {visible}",
			"filter.label": "筛选模型",
			"filter.multimodal": "多模态",
			"filter.all": "全部",
			"filter.on": "已启用",
			"filter.off": "未启用",
			"sel.allVisible": "全选显示项",
			"sel.all": "全选",
			"sel.invert": "反选",
			"sel.clearVisible": "取消显示项",
			"sel.clear": "清空",
			"list.empty": "没有可用模型。",
			"list.noMatch": "没有匹配的模型。",
			"btn.applying": "应用中…",
			"btn.disableAll": "停用全部模型",
			"btn.enable": "启用所选 ({n})",
			"btn.discard": "放弃更改",
			"dirty": "有未保存的更改",
			"conflict.title": "模型重复了",
			"conflict.body": "你在默认的模型配置里也启用了 OpenCode GO，所以这些模型会出现两次。",
			"conflict.models": "（{n} 个模型）",
			"conflict.remove": "删掉 {provider}",
			"conflict.removing": "移除中…",
			"conflict.removed": "已移除路由 {provider}。",
			"conflict.failed": "移除失败：{msg}",
			"usage.row": "OpenCode Go 用量",
			"usage.title": "OpenCode Go 用量限制",
			"usage.window.rolling": "5 小时",
			"usage.window.weekly": "每周",
			"usage.window.monthly": "每月",
			"usage.short.rolling": "5h",
			"usage.short.weekly": "周",
			"usage.short.monthly": "月",


			"usage.loading": "正在读取用量…",
			"usage.unavailable": "暂不可用",
			"usage.noKey": "未配置 API Key",
			"usage.auth": "凭据无效",
			"usage.limited": "已达限额",
			"usage.resetting": "即将重置",

			"usage.updatedAt": "更新于 {time}",
			"usage.connect": "未配置 API Key · 去插件设置",
			"usage.console": "在控制台打开",
			"usage.openSettings": "去插件设置填写",
			"usage.rowAria": "{window}：已用 {percent}，{reset} 重置",
			"usage.percentAria": "已用 {percent}",
			"usage.rowAriaLimited": "{window}：已达限额",
		};
		const en = {
			"cap.context": "{value} context",
			"cap.output": "{value} output",
			"cap.image": "Image",
			"save.failed": "Save failed: {msg}",
			"save.ok": "Saved. Gateway {url}{key}",
			"save.keySet": ", API key configured",
			"save.keyUnset": ", API key not configured",
			"test.failed": "Connection failed: {msg}",
			"test.api.anthropic": "Anthropic protocol",
			"test.api.openai": "OpenAI protocol",
			"test.api.responses": "OpenAI Responses protocol",
			"test.ok": "Connected: credential accepted · {summary} · {ms} ms",
			"test.blocked": " · but {detail}",
			"test.unsaved": " · tested the field values, which are not saved yet",
			"test.passed": "passed",
			"fetch.failed": "Fetch failed: {msg}",
			"fetch.empty": "The gateway returned no models",
			"apply.failed": "Apply failed: {msg}",
			"apply.none": "All models disabled; the picker no longer lists them.",
			"apply.ok": "Enabled {n} model(s).",
			"title.loading": "Loading…",
			"title.count": "{n} model(s) enabled",
			"desc": "Connect to the OpenCode GO gateway and choose which models to use here.",
			"field.baseUrl": "Gateway URL",
			"key.configured": "API key configured",
			"key.unconfigured": "API key not configured",
			"key.placeholderSet": "Configured — leave blank to keep",
			"key.placeholderNew": "Paste the API key",
			"key.label": "API key",
			"btn.saving": "Saving…",
			"btn.save": "Save",
			"btn.testing": "Testing…",
			"btn.test": "Test connection",
			"conn.hint": "Save stores the fields above; Test connection probes them as typed, so saving first is not required.",
			"models.loading": "Loading model configuration…",
			"models.all": "No fixed list yet; every available model is served.",
			"models.selected": "Only the selected models are served; clear the selection to disable all.",
			"models.via": "Candidates from {url}",
			"models.stale": "No longer offered: {ids}",
			"models.undocumented": "No longer in the catalog, possibly retired: {ids}",
			"btn.checking": "Checking…",
			"btn.check": "Check model availability",
			"check.ok": "Checked {n} model(s), all available · {ms} ms",
			"check.blocked": " · also restricted by policy or region: {ids}",
			"check.unavailable": "The gateway still lists these, but the provider no longer serves them: {ids} (checked {n} · {ms} ms)",
			"check.failed": "Check failed: {msg}",
			"check.removed": "Removed and saved: {ids} ({n} now enabled)",
			"check.dirty": "There are unapplied changes; click Enable selected or Discard first, then remove these models.",
			"check.drop": "Remove these models and save",
			"row.undocumented": "Not in catalog",
			"btn.fetching": "Fetching…",
			"btn.refetch": "Refresh list",
			"search.placeholder": "Search models",
			"count": "{picked} / {total} selected",
			"count.visible": "{picked} / {total} selected · {visible} shown",
			"filter.label": "Filter models",
			"filter.multimodal": "Multimodal",
			"filter.all": "All",
			"filter.on": "Enabled",
			"filter.off": "Disabled",
			"sel.allVisible": "Select shown",
			"sel.all": "Select all",
			"sel.invert": "Invert",
			"sel.clearVisible": "Clear shown",
			"sel.clear": "Clear",
			"list.empty": "No models available.",
			"list.noMatch": "No matching models.",
			"btn.applying": "Applying…",
			"btn.disableAll": "Disable all models",
			"btn.enable": "Enable selected ({n})",
			"btn.discard": "Discard changes",
			"dirty": "Unsaved changes",
			"conflict.title": "These models are listed twice",
			"conflict.body": "You also enabled OpenCode GO in the default model configuration, so these models appear twice.",
			"conflict.models": "({n} models)",
			"conflict.remove": "Delete {provider}",
			"conflict.removing": "Removing…",
			"conflict.removed": "Removed route {provider}.",
			"conflict.failed": "Removal failed: {msg}",
			"usage.row": "OpenCode Go usage",
			"usage.title": "OpenCode Go limits",
			"usage.window.rolling": "5 hours",
			"usage.window.weekly": "Weekly",
			"usage.window.monthly": "Monthly",
			"usage.short.rolling": "5h",
			"usage.short.weekly": "wk",
			"usage.short.monthly": "mo",


			"usage.loading": "Reading usage…",
			"usage.unavailable": "Unavailable",
			"usage.noKey": "No API key configured",
			"usage.auth": "Credential rejected",
			"usage.limited": "Limit reached",
			"usage.resetting": "Resetting",

			"usage.updatedAt": "Updated {time}",
			"usage.connect": "No API key · open plugin settings",
			"usage.console": "Open in console",
			"usage.openSettings": "Open plugin settings",
			"usage.rowAria": "{window}: {percent} used, resets {reset}",
			"usage.percentAria": "{percent} used",
			"usage.rowAriaLimited": "{window}: limit reached",
		};

		const API = {
			info: "/dsh-opencode-go-plus/models-info",
			apply: "/dsh-opencode-go-plus/models-apply",
			config: "/dsh-opencode-go-plus/config",
			test: "/dsh-opencode-go-plus/test",
			check: "/dsh-opencode-go-plus/models-check",
			removeRoute: "/dsh-opencode-go-plus/remove-route",
			usage: "/dsh-opencode-go-plus/usage",
			ringReport: "/dsh-opencode-go-plus/ring-report"
		};

		// ── styles (injected once) ──
		const CSS_ID = "dsh-opencode-go-plus/card.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-opencode-go-plus";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".ocgp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;list-style:none;background:var(--dsw-alias-bg-layer-3);padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
				".ocgp-head{display:flex;flex-direction:column;gap:3px;min-width:0}",
				".ocgp-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
				".ocgp-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
				".ocgp-section{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}",
				".ocgp-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
				".ocgp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".ocgp-field{flex:1;min-width:180px;box-sizing:border-box;height:32px;padding:0 10px;font:inherit;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
				".ocgp-field:disabled{opacity:.5}",
				".ocgp-btn{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border-radius:16px;padding:0 14px;font-size:13px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:none}",
				".ocgp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
				".ocgp-btn:disabled{opacity:.5;cursor:default}",
				".ocgp-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:none}",
				".ocgp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
				".ocgp-link{cursor:pointer;border:none;background:none;padding:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
				".ocgp-link:hover{color:var(--dsw-alias-label-primary)}",
				".ocgp-line{padding:2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
				".ocgp-hint{padding:2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
				".ocgp-ok{color:var(--dsw-alias-state-success-primary)}",
				".ocgp-err{color:var(--dsw-alias-state-error-primary)}",
				".ocgp-warn{color:var(--dsw-alias-state-warning-primary,#c98a00)}",
				".ocgp-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;font-size:11px;line-height:16px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
				".ocgp-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);vertical-align:middle}",
				".ocgp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".ocgp-toolbar-actions{display:inline-flex;align-items:center;gap:10px;margin-left:auto}",
				".ocgp-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
				".ocgp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden}",
				".ocgp-seg button{box-sizing:border-box;height:26px;padding:0 10px;font:inherit;font-size:12px;line-height:24px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}",
				".ocgp-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}",
				".ocgp-seg button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".ocgp-seg button[aria-pressed=\"true\"]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
				".ocgp-chip{box-sizing:border-box;height:26px;padding:0 10px;font:inherit;font-size:12px;line-height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}",
				".ocgp-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".ocgp-chip[aria-pressed=\"true\"]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
				".ocgp-link:disabled{opacity:.4;cursor:default}",
				".ocgp-list{display:flex;flex-direction:column;gap:1px;margin:0;padding:4px;list-style:none;max-height:min(340px,42vh);overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".ocgp-cand{border-radius:6px;display:flex;align-items:flex-start;gap:8px;padding:5px 8px;cursor:pointer}",
				".ocgp-cand:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				// the read-only row shares the layout but is not clickable, so it
				// must not suggest otherwise
				".ocgp-cand input{flex:none;margin-top:2px}",
				".ocgp-cand-body{flex:1;min-width:0}",
				// Two lines per model: the readable name, then its facts. The
				// gateway id is a near-duplicate of the name for most models
				// (glm-5.3-flash / GLM-5.3-Flash), so it is shown only when it
				// says something the name does not.
				".ocgp-cand-name{font-size:13px;line-height:17px;color:var(--dsw-alias-label-primary);font-weight:500;overflow-wrap:anywhere}",
				".ocgp-cand-desc{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
				".ocgp-cand-key{font-family:var(--ds-font-family-code)}"
			].join("");
			document.head.appendChild(tag);
		}

		/**
		 * Compact capacity spelling. Vendors mix the two bases — 384000 is
		 * "384K" while 131072 is "128K" — so pick the base that divides evenly:
		 * an exact 1024-multiple is binary, otherwise decimal.
		 * 1000000 -> "1M" · 1048576 -> "1M" · 131072 -> "128K" · 384000 -> "384K"
		 */
		function fmtCap(n) {
			if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
			if (n >= 1048576 && n % 1048576 === 0) return (n / 1048576) + "M";
			if (n >= 1000000) return (Math.round((n / 1000000) * 100) / 100) + "M";
			if (n % 1000 === 0) return (n / 1000) + "K";
			if (n % 1024 === 0) return (n / 1024) + "K";
			if (n >= 1000) return Math.round(n / 1000) + "K";
			return String(n);
		}

		/** A candidate's description, built from metadata only (never prose). */
		function candDesc(c, t) {
			const parts = [];
			const ctx = fmtCap(c.contextWindow);
			const max = fmtCap(c.maxTokens);
			if (ctx) parts.push(t("cap.context", { value: ctx }));
			if (max) parts.push(t("cap.output", { value: max }));
			if (c.input && c.input.indexOf("image") !== -1) parts.push(t("cap.image"));
			return parts.join(" · ");
		}

		/**
		 * Whether a model's gateway id is worth a second line.
		 *
		 * For most models the catalog name is just the id restyled — `hy3` /
		 * `Hy3`, `glm-5.3-flash` / `GLM-5.3-Flash` — and printing both wastes a
		 * line on every row. Only when the two differ beyond case and
		 * punctuation does the id carry information the name does not
		 * (`union-alpha` / `Union Alpha Free`).
		 * @param {Record<string, unknown>} c
		 * @returns {boolean}
		 */
		function showsGatewayId(c) {
			if (typeof c.name !== "string" || c.name.length === 0) return false;
			const strip = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
			return strip(c.name) !== strip(c.id);
		}

		/** JSON request helper that never throws on a non-2xx or unparsable body. */
		function requestJson(url, init) {
			return fetch(url, { cache: "no-store", ...init })
				.then((res) => res.json().catch(() => null).then((json) => ({ res, json })))
				.catch((error) => ({ res: { ok: false, status: 0 }, json: { ok: false, error: String((error && error.message) || error) } }));
		}

		function ModelsCard(props) {
			const t = (props && props.t) || ((key) => key);
			const [info, setInfo] = react.useState(null);
			const [config, setConfig] = react.useState(null);
			const [baseURL, setBaseURL] = react.useState("");
			const [apiKey, setApiKey] = react.useState("");
			const [candidates, setCandidates] = react.useState(null);
			const [picked, setPicked] = react.useState(new Set());
			const [baseline, setBaseline] = react.useState(new Set());
			const [query, setQuery] = react.useState("");
			const [scope, setScope] = react.useState("all");
			const [multimodalOnly, setMultimodalOnly] = react.useState(false);
			const [fetching, setFetching] = react.useState(false);
			const [applying, setApplying] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [testing, setTesting] = react.useState(false);
			const [via, setVia] = react.useState(null);
			const [connLine, setConnLine] = react.useState(null);
			const [modelLine, setModelLine] = react.useState(null);
			const [checking, setChecking] = react.useState(false);
			const [checkLine, setCheckLine] = react.useState(null);
			// models the last availability check found retired upstream, so the
			// card can offer to drop them from the selection
			const [unavailable, setUnavailable] = react.useState([]);
			const [conflicts, setConflicts] = react.useState([]);
			const [removing, setRemoving] = react.useState(null);

			// One load populates everything: the served set, the live list as
			// editable candidates, and the conflict scan. The draft resets to the
			// committed selection, which is correct at every call site — mount,
			// save, apply, removal — because each is either the first read or the
			// moment just after a commit.
			const loadInfo = react.useCallback(() => {
				return requestJson(API.info).then(({ res, json }) => {
					if (json && json.ok) {
						setInfo(json);
						setConflicts(Array.isArray(json.conflicts) ? json.conflicts : []);
						if (Array.isArray(json.candidates)) {
							setCandidates(json.candidates);
							const enabledIds = new Set(json.candidates.filter((c) => c.enabled).map((c) => c.id));
							setPicked(enabledIds);
							setBaseline(enabledIds);
						}
						if (json.via) setVia(String(json.via));
						// the gateway list could not be read; the candidates are
						// then just the served set, which is worth saying
						if (json.liveError) setModelLine({ ok: false, text: t("fetch.failed", { msg: String(json.liveError) }) });
					} else if (res.status === 0 || !json) {
						setModelLine({ ok: false, text: t("fetch.failed", { msg: "HTTP " + res.status }) });
					}
				});
			}, []);

			/** Remove a duplicate route, then re-scan. */
			const removeConflict = async (entry) => {
				const key = entry.settingsNs + "/" + entry.settingsPath.join(".");
				setRemoving(key);
				setConnLine(null);
				try {
					const { res, json } = await requestJson(API.removeRoute, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ settingsNs: entry.settingsNs, settingsPath: entry.settingsPath })
					});
					if (res.status === 0 || !json || json.ok !== true) {
						setConnLine({ ok: false, text: t("conflict.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return;
					}
					setConflicts(Array.isArray(json.remaining) ? json.remaining : []);
					setConnLine({ ok: true, text: t("conflict.removed", { provider: entry.provider }) });
				} finally {
					setRemoving(null);
				}
			};

			react.useEffect(() => {
				let alive = true;
				// the card opens with the live model list already loaded, so no
				// button press is needed to see or change the selection
				loadInfo();
				requestJson(API.config).then(({ json }) => {
					if (alive && json && json.ok) {
						setConfig(json);
						setBaseURL(json.baseURL || "");
					}
				});
				return () => { alive = false; };
			}, []);

			const saveConnection = async () => {
				setSaving(true);
				setConnLine(null);
				try {
					const body = { baseURL: baseURL.trim() };
					if (apiKey.length > 0) body.apiKey = apiKey;
					const { res, json } = await requestJson(API.config, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body)
					});
					if (res.status === 0 || !json || json.ok !== true) {
						setConnLine({ ok: false, text: t("save.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return;
					}
					setConfig(json);
					setBaseURL(json.baseURL || "");
					setApiKey("");
					setConnLine({
						ok: true,
						text: t("save.ok", { url: json.baseURL, key: t(json.keyConfigured ? "save.keySet" : "save.keyUnset") })
					});
					loadInfo();
				} finally {
					setSaving(false);
				}
			};

			const testConnection = async () => {
				setTesting(true);
				setConnLine(null);
				try {
					// Test the values in the fields, not the saved ones: the
					// question this button answers is "do these values work?",
					// which must not depend on saving first. An empty key field
					// means "reuse the stored credential", exactly as Save does.
					const { res, json } = await requestJson(API.test, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ baseURL: baseURL.trim(), apiKey })
					});
					// Whether the fields hold values that are not saved yet. The
					// result says so, so a passing draft test is not mistaken
					// for a stored configuration.
					const unsaved = baseURL.trim() !== String((config && config.baseURL) ?? "") || apiKey.length > 0;
					if (res.status === 0 || !json || json.ok !== true) {
						setConnLine({
							ok: false,
							text: t("test.failed", { msg: String((json && json.error) || "HTTP " + res.status) })
								+ (unsaved ? t("test.unsaved") : "")
						});
						return;
					}
					// the probe reports one line per wire protocol it checked,
					// because the two carry different credentials. A check can
					// pass on credentials yet have its model refused (a 403
					// policy or region block); that is worth stating, since the
					// test would otherwise read as "everything works" while that
					// model stays unusable.
					const checks = Array.isArray(json.checks) ? json.checks : [];
					const apiLabel = (api) => t(api === "anthropic-messages"
						? "test.api.anthropic"
						: api === "openai-responses" ? "test.api.responses" : "test.api.openai");
					const summary = checks
						.map((check) => apiLabel(check.api) + (check.blocked === true ? " !" : " ✓"))
						.join(" · ");
					const blocked = checks
						.filter((check) => check.blocked === true)
						.map((check) => check.detail)
						.filter((detail) => typeof detail === "string" && detail.length > 0)
						.join(" / ");
					setConnLine({
						ok: true,
						text: t("test.ok", { summary: summary || t("test.passed"), ms: json.ms })
							+ (blocked.length > 0 ? t("test.blocked", { detail: blocked }) : "")
							+ (unsaved ? t("test.unsaved") : "")
					});
				} finally {
					setTesting(false);
				}
			};

			// Ask the gateway about every enabled model, one request each.
			// `/v1/models` cannot answer this: it kept advertising union-alpha
			// after the provider retired it, so only a real request tells.
			const checkAvailability = async () => {
				setChecking(true);
				setCheckLine(null);
				setUnavailable([]);
				try {
					const { res, json } = await requestJson(API.check, { method: "POST" });
					if (res.status === 0 || !json || json.ok !== true) {
						setCheckLine({ ok: false, text: t("check.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return;
					}
					const gone = Array.isArray(json.unavailable) ? json.unavailable : [];
					const blocked = Array.isArray(json.blocked) ? json.blocked : [];
					setUnavailable(gone);
					setCheckLine({
						ok: gone.length === 0,
						text: gone.length > 0
							? t("check.unavailable", { ids: gone.join(", "), n: json.checked, ms: json.ms })
							: t("check.ok", { n: json.checked, ms: json.ms })
								+ (blocked.length > 0 ? t("check.blocked", { ids: blocked.join(", ") }) : "")
					});
				} finally {
					setChecking(false);
				}
			};

			// Remove the models the check found retired, and commit the result.
			//
			// The committed set comes from the served ids the check just iterated,
			// not from the checkbox draft: that draft is a convenience for editing
			// and can legitimately differ — and it also cannot represent a model
			// that is enabled but absent from the gateway's listing, which is
			// exactly the stale case this exists to clean up.
			//
			// The draft may hold unapplied edits, though, and writing would discard
			// them silently, so that case asks the user to commit or discard first.
			const dropUnavailable = async () => {
				const gone = [...unavailable];
				if (gone.length === 0) return;
				if (dirty) {
					setCheckLine({ ok: false, text: t("check.dirty") });
					return;
				}
				const served = info && Array.isArray(info.models) ? info.models : [];
				const applied = await commitIds(served.filter((id) => !gone.includes(id)), { quiet: true });
				if (applied === null) return;
				setUnavailable([]);
				setCheckLine({ ok: true, text: t("check.removed", { ids: gone.join(", "), n: applied.size }) });
			};

			// Re-read the live list. Kept separate from `loadInfo` only so the
			// button can show its own busy state; the work is the same request.
			const reload = async () => {
				setFetching(true);
				setModelLine(null);
				try {
					await loadInfo();
				} finally {
					setFetching(false);
				}
			};

			const toggle = (id) => {
				setPicked((s) => {
					const next = new Set(s);
					if (!next.delete(id)) next.add(id);
					return next;
				});
			};

			/** Bulk edits act on what the user can SEE (search + filter applied). */
			const selectVisible = () => {
				setPicked((s) => {
					const next = new Set(s);
					for (const c of visible) next.add(c.id);
					return next;
				});
			};
			const deselectVisible = () => {
				setPicked((s) => {
					const next = new Set(s);
					for (const c of visible) next.delete(c.id);
					return next;
				});
			};
			const invertVisible = () => {
				setPicked((s) => {
					const next = new Set(s);
					for (const c of visible) {
						if (next.has(c.id)) next.delete(c.id);
						else next.add(c.id);
					}
					return next;
				});
			};
			/** Discard edits and return to what the gateway currently serves. */
			const resetToEnabled = () => setPicked(new Set(configuredIds));

			/**
			 * Commit an explicit id set. Shared by the selection's apply button
			 * and by the availability check's removal, which has to be able to
			 * write without a candidate list loaded.
			 * @param {Iterable<string>} ids
			 * @param {{ quiet?: boolean }} [options] - suppress the generic
			 *   "enabled N models" line when the caller reports its own result.
			 * @returns {Promise<Set<string>|null>} the committed set, or null.
			 */
			const commitIds = async (ids, { quiet = false } = {}) => {
				setApplying(true);
				setModelLine(null);
				try {
					const { res, json } = await requestJson(API.apply, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ids: [...ids] })
					});
					if (res.status === 0 || !json || json.ok !== true) {
						setModelLine({ ok: false, text: t("apply.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return null;
					}
					if (!quiet) {
						setModelLine({
							ok: true,
							text: json.total === 0
								? t("apply.none")
								: t("apply.ok", { n: json.total })
						});
					}
					// The committed set is the new baseline for change detection —
					// and it is also the new "currently enabled" state. Updating
					// only the baseline left every candidate's `enabled` flag at
					// its pre-apply value, so the scope filter, the row tags and
					// "Discard changes" all worked against the OLD selection:
					// discard after apply silently reverted the committed state.
					const applied = new Set(json.models || []);
					// `picked` is synced too: a caller may commit a set the
					// checkbox draft does not equal (removal does exactly that),
					// and the boxes render from `picked`.
					setPicked(applied);
					setBaseline(applied);
					setCandidates((current) => current === null
						? null
						: current.map((c) => applied.has(c.id) === c.enabled ? c : { ...c, enabled: applied.has(c.id) }));
					loadInfo();
					return applied;
				} finally {
					setApplying(false);
				}
			};

			const apply = () => commitIds(picked);

			const count = info && typeof info.configured === "number" ? info.configured : null;
			const fromCatalog = info && info.fromCatalog === true;
			const stale = info && Array.isArray(info.stale) ? info.stale : [];
			const undocumented = info && Array.isArray(info.undocumented) ? info.undocumented : [];
			const keyConfigured = config && config.keyConfigured === true;
			// The card renders one list: the gateway's live models, with the
			// served ones checked. It arrives with the models-info payload, so
			// there is no separate "load the list" step to take first, and no
			// read-only mode that could drift from the editable one.
			const configuredIds = candidates === null
				? []
				: candidates.filter((c) => c.enabled).map((c) => c.id);
			const needle = query.trim().toLowerCase();
			const visible = candidates === null ? [] : candidates.filter((c) => {
				if (scope === "on" && !c.enabled) return false;
				if (scope === "off" && c.enabled) return false;
				if (multimodalOnly && !(Array.isArray(c.input) && c.input.includes("image"))) return false;
				if (needle.length === 0) return true;
				return (c.id + " " + (c.name || "")).toLowerCase().includes(needle);
			});
			const visiblePicked = visible.filter((c) => picked.has(c.id)).length;
			// unsaved-edit detection against the baseline (the last committed set)
			const dirty = candidates !== null
				&& (picked.size !== baseline.size || [...picked].some((id) => !baseline.has(id)));
			const allVisiblePicked = visible.length > 0 && visiblePicked === visible.length;

			return react_jsx_runtime.jsx("li", {
				className: "ocgp-card",
				children: [
					react_jsx_runtime.jsx("div", {
						className: "ocgp-head",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "ocgp-title",
								children: [
									"OpenCode GO Plus",
									react_jsx_runtime.jsx("span", {
										className: "ocgp-badge",
										children: count === null ? t("title.loading") : t("title.count", { n: count })
									})
								]
							}),
							react_jsx_runtime.jsx("div", {
								className: "ocgp-desc",
								children: t("desc")
							})
						]
					}),

					// ── connection ──
					react_jsx_runtime.jsx("div", {
						className: "ocgp-section",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "ocgp-label",
								children: [
									t("field.baseUrl"),
									react_jsx_runtime.jsx("span", {
										className: "ocgp-badge",
										children: t(keyConfigured ? "key.configured" : "key.unconfigured")
									})
								]
							}),
							react_jsx_runtime.jsx("div", {
								className: "ocgp-row",
								children: react_jsx_runtime.jsx("input", {
									className: "ocgp-field",
									type: "text",
									value: baseURL,
									placeholder: "https://opencode.ai/zen/go",
									"aria-label": t("field.baseUrl"),
									disabled: saving,
									onChange: (event) => setBaseURL(event.target.value)
								})
							}),
							react_jsx_runtime.jsx("div", {
								className: "ocgp-row",
								children: [
									react_jsx_runtime.jsx("input", {
										className: "ocgp-field",
										type: "password",
										value: apiKey,
										placeholder: t(keyConfigured ? "key.placeholderSet" : "key.placeholderNew"),
										"aria-label": t("key.label"),
										disabled: saving,
										onChange: (event) => setApiKey(event.target.value)
									}),
									react_jsx_runtime.jsx("button", {
										className: "ocgp-btn ocgp-primary",
										onClick: saveConnection,
										disabled: saving || baseURL.trim().length === 0,
										children: saving ? t("btn.saving") : t("btn.save")
									}),
									react_jsx_runtime.jsx("button", {
										className: "ocgp-btn",
										onClick: testConnection,
										// an empty URL has nothing to test; the field is
										// seeded from the saved config, so empty means
										// the user cleared it
										disabled: testing || baseURL.trim().length === 0,
										children: testing ? t("btn.testing") : t("btn.test")
									})
								]
							}),
							// The two buttons are independent: Save persists the
							// fields, Test probes them as typed. Saying so removes
							// the "must I save first?" question.
							react_jsx_runtime.jsx("div", {
								className: "ocgp-hint",
								children: t("conn.hint")
							}),
							connLine ? react_jsx_runtime.jsx("div", {
								className: connLine.ok ? "ocgp-line ocgp-ok" : "ocgp-line ocgp-err",
								children: connLine.text
							}) : null
						]
					}),

					// ── duplicate routes ──
					// Shown only when the scan found another route on the same
					// gateway: those models appear twice in the picker, and the
					// fix belongs next to the list it corrupts.
					conflicts.length > 0 ? react_jsx_runtime.jsx("div", {
						className: "ocgp-section",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "ocgp-line ocgp-warn",
								children: t("conflict.title")
							}),
							...conflicts.map((entry) => {
								const key = entry.settingsNs + "/" + entry.settingsPath.join(".");
								return react_jsx_runtime.jsx("div", {
									className: "ocgp-row",
									children: [
										react_jsx_runtime.jsx("div", {
											className: "ocgp-label",
											children: [
												t("conflict.body", { provider: entry.provider, ns: entry.settingsNs }),
												entry.modelCount === null ? null : react_jsx_runtime.jsx("div", {
													className: "ocgp-cand-desc",
													children: t("conflict.models", { n: entry.modelCount })
												})
											]
										}),
										entry.removable ? react_jsx_runtime.jsx("button", {
											type: "button",
											className: "ocgp-btn",
											disabled: removing !== null,
											onClick: () => removeConflict(entry),
											children: removing === key ? t("conflict.removing") : t("conflict.remove", { provider: entry.provider })
										}) : null
									]
								}, key);
							})
						]
					}) : null,

					// ── models ──
					react_jsx_runtime.jsx("div", {
						className: "ocgp-section",
						children: [
							react_jsx_runtime.jsx("div", {
								className: "ocgp-label",
								children: info === null
									? t("models.loading")
									: fromCatalog ? t("models.all") : t("models.selected")
							}),
							via ? react_jsx_runtime.jsx("div", { className: "ocgp-line", children: t("models.via", { url: via }) }) : null,
							stale.length > 0 ? react_jsx_runtime.jsx("div", {
								className: "ocgp-line ocgp-warn",
								children: t("models.stale", { ids: stale.join(", ") })
							}) : null,
							// The catalog dropping a model is the earliest free
							// hint that it is on the way out; the button below is
							// what confirms it with a real request.
							undocumented.length > 0 ? react_jsx_runtime.jsx("div", {
								className: "ocgp-line ocgp-warn",
								children: t("models.undocumented", { ids: undocumented.join(", ") })
							}) : null,
							react_jsx_runtime.jsx("div", {
								className: "ocgp-row",
								children: [
									react_jsx_runtime.jsx("button", {
										className: "ocgp-btn",
										onClick: reload,
										disabled: fetching || applying,
										children: fetching ? t("btn.fetching") : t("btn.refetch")
									}),
									react_jsx_runtime.jsx("button", {
										className: "ocgp-btn",
										onClick: checkAvailability,
										disabled: checking || applying || count === 0,
										children: checking ? t("btn.checking") : t("btn.check")
									}),
									candidates !== null ? react_jsx_runtime.jsx("input", {
										className: "ocgp-field",
										type: "search",
										value: query,
										placeholder: t("search.placeholder"),
										"aria-label": t("search.placeholder"),
										onChange: (event) => setQuery(event.target.value)
									}) : null
								]
							}),
							checkLine ? react_jsx_runtime.jsx("div", {
								className: checkLine.ok ? "ocgp-line ocgp-ok" : "ocgp-line ocgp-err",
								children: [
									checkLine.text,
									unavailable.length > 0 ? react_jsx_runtime.jsx("button", {
										type: "button",
										className: "ocgp-link",
										style: { marginLeft: "8px" },
										disabled: applying,
										onClick: dropUnavailable,
										children: t("check.drop")
									}) : null
								]
							}) : null,

							// ── selection toolbar (only once candidates exist) ──
							candidates !== null ? react_jsx_runtime.jsx("div", {
								className: "ocgp-toolbar",
								children: [
									react_jsx_runtime.jsx("span", {
										className: "ocgp-count",
										children: visible.length === candidates.length
											? t("count", { picked: picked.size, total: candidates.length })
											: t("count.visible", { picked: picked.size, total: candidates.length, visible: visible.length })
									}),
									react_jsx_runtime.jsx("div", {
										className: "ocgp-seg",
										role: "group",
										"aria-label": t("filter.label"),
										children: [["all", "filter.all"], ["on", "filter.on"], ["off", "filter.off"]].map(([value, label]) =>
											react_jsx_runtime.jsx("button", {
												type: "button",
												key: value,
												"aria-pressed": scope === value,
												onClick: () => setScope(value),
												children: t(label)
											}, value))
									}),
									react_jsx_runtime.jsx("button", {
										type: "button",
										className: "ocgp-chip",
										"aria-pressed": multimodalOnly,
										onClick: () => setMultimodalOnly((value) => !value),
										children: t("filter.multimodal")
									}),
									react_jsx_runtime.jsx("div", {
										className: "ocgp-toolbar-actions",
										children: [
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "ocgp-link",
												onClick: selectVisible,
												disabled: visible.length === 0 || allVisiblePicked,
												children: t(query.trim().length > 0 || scope !== "all" || multimodalOnly ? "sel.allVisible" : "sel.all")
											}),
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "ocgp-link",
												onClick: invertVisible,
												disabled: visible.length === 0,
												children: t("sel.invert")
											}),
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "ocgp-link",
												onClick: deselectVisible,
												disabled: visiblePicked === 0,
												children: t(query.trim().length > 0 || scope !== "all" || multimodalOnly ? "sel.clearVisible" : "sel.clear")
											})
										]
									})
								]
							}) : null,

							modelLine ? react_jsx_runtime.jsx("div", {
								className: modelLine.ok ? "ocgp-line ocgp-ok" : "ocgp-line ocgp-err",
								children: modelLine.text
							}) : null,
							visible.length > 0
								? react_jsx_runtime.jsx("ul", {
									className: "ocgp-list",
									children: visible.map((c, index) => {
										const boxId = "ocgp-cand-" + index;
										const facts = candDesc(c, t);
										const showKey = showsGatewayId(c);
										return react_jsx_runtime.jsx("li", {
											children: react_jsx_runtime.jsx("label", {
												className: "ocgp-cand",
												htmlFor: boxId,
												// the row's stable identity, independent of
												// how its name happens to be rendered
												"data-model": c.id,
												children: [
													react_jsx_runtime.jsx("input", {
														id: boxId,
														type: "checkbox",
														checked: picked.has(c.id),
														onChange: () => toggle(c.id)
													}),
													react_jsx_runtime.jsx("div", {
														className: "ocgp-cand-body",
														children: [
															react_jsx_runtime.jsx("div", {
																className: "ocgp-cand-name",
																children: [
																	c.name || c.id,
																	c.undocumented === true ? react_jsx_runtime.jsx("span", {
																		className: "ocgp-tag",
																		children: t("row.undocumented")
																	}) : null
																]
															}),
															react_jsx_runtime.jsx("div", {
																className: "ocgp-cand-desc",
																children: [
																	showKey ? react_jsx_runtime.jsx("span", {
																		className: "ocgp-cand-key",
																		children: c.id
																	}) : null,
																	showKey && facts.length > 0 ? " · " : null,
																	facts
																]
															})
														]
													})
												]
											})
										}, c.id);
									})
								})
								: null,
							candidates !== null && visible.length === 0
								? react_jsx_runtime.jsx("div", {
									className: "ocgp-line",
									children: t(candidates.length === 0 ? "list.empty" : "list.noMatch")
								})
								: null,

							// ── commit ──
							candidates !== null
								? react_jsx_runtime.jsx("div", {
									className: "ocgp-row",
									children: [
										react_jsx_runtime.jsx("button", {
											className: "ocgp-btn ocgp-primary",
											onClick: apply,
											disabled: applying || !dirty,
											children: applying
												? t("btn.applying")
												: picked.size === 0 ? t("btn.disableAll") : t("btn.enable", { n: picked.size })
										}),
										dirty ? react_jsx_runtime.jsx("button", {
											type: "button",
											className: "ocgp-link",
											onClick: resetToEnabled,
											disabled: applying,
											children: t("btn.discard")
										}) : null,
										dirty ? react_jsx_runtime.jsx("span", {
											className: "ocgp-line ocgp-warn",
											children: t("dirty")
										}) : null
									]
								})
								: null
						]
					})
				]
			});
		}

		// ── account-menu usage (Codex-style limits) ────────────────────────
		// DSH ships no row seat inside the sidebar account menu, and replacing
		// `settings.launcher` would shadow the shipped account menu whole
		// (settings, feedback, sign-out, bonus notices). So the row is ADDED at
		// runtime: when the account menu opens, one `display:contents` container
		// lands right after its first item, and a second React root renders the
		// toggle row plus the expandable three-window panel inside it.
		//
		// Everything below is additive and keyed to observable structure only. If
		// a future shell changes the trigger or menu shape, the row stops
		// appearing — the shipped account menu keeps working untouched.
		const USAGE_WINDOWS = ["rolling", "weekly", "monthly"];
		/** Card ids must be unique per mounted section (the menu remounts). */
		let USAGE_PANEL_SEQ = 0;

		/** A percentage as the UI prints it (`3%`); an em dash when withheld. */
		function formatPercent(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
		}

		/**
		 * The window keys to render, in a stable order: the three the gateway
		 * documents first, then anything it adds later — so a future `daily` window
		 * shows up without a code change (its label falls back to the raw key).
		 */
		function usageWindows(usage) {
			if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return [];
			const keys = [];
			for (const key of USAGE_WINDOWS) {
				const view = usage[key];
				if (view !== null && typeof view === "object") keys.push(key);
			}
			for (const key of Object.keys(usage)) {
				if (USAGE_WINDOWS.includes(key)) continue;
				const view = usage[key];
				if (view !== null && typeof view === "object") keys.push(key);
			}
			return keys;
		}

		/**
		 * The reset instant in the reader's own language: a clock time inside a day,
		 * a calendar date beyond it. `Intl` owns the format, so every locale (and
		 * every 12/24-hour convention) is covered without a per-language branch, and
		 * there is no plural to get wrong.
		 */
		function formatResetValue(resetsAt, now, localeTag, t) {
			const at = typeof resetsAt === "string" ? Date.parse(resetsAt) : NaN;
			if (!Number.isFinite(at)) return "—";
			const reference = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
			const delta = at - reference;
			if (delta <= 0) return t("usage.resetting");
			const date = new Date(at);
			const options = delta < 24 * 3600 * 1000
				? { hour: "2-digit", minute: "2-digit" }
				: { month: "short", day: "numeric" };
			try {
				return new Intl.DateTimeFormat(localeTag === undefined || localeTag === "" ? undefined : localeTag, options).format(date);
			} catch {
				return date.toLocaleString();
			}
		}

		/** Freshness stamp (`13:30`) in the reader's language, or null when unknown. */
		function formatUpdatedAt(fetchedAt, localeTag) {
			if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) return null;
			try {
				return new Intl.DateTimeFormat(localeTag === undefined || localeTag === "" ? undefined : localeTag, { hour: "2-digit", minute: "2-digit" }).format(new Date(fetchedAt));
			} catch {
				return new Date(fetchedAt).toLocaleTimeString();
			}
		}

		/** The tooltip for one ring half: `20% 5h` / `88% wk`. */
		function hoverReading(key, rolling, weekly, t) {
			const used = key === "rolling" ? rolling : weekly;
			// The ring is headroom, so its tooltip is headroom too: "80% 5h" means 80% of
			// the 5-hour allowance is still there. The card keeps the gateway's "used".
			const left = typeof used === "number" ? Math.max(0, 100 - Math.max(0, Math.min(100, used))) : null;
			return `${formatPercent(left)} ${t(`usage.short.${key}`)}`;
		}

		/**
		 * Where the card goes: above the ring, horizontally centred on it, always fully
		 * inside the viewport. Pure so the three-width matrix can be asserted without a
		 * browser.
		 */
		function cardAnchor(ring, viewport, cardWidth = 248) {
			const width = typeof cardWidth === "number" && cardWidth > 0 ? cardWidth : 248;
			const centre = (ring.left + ring.right) / 2;
			const left = Math.round(Math.max(8, Math.min(viewport.width - width - 8, centre - width / 2)));
			const bottom = Math.round(Math.max(8, viewport.height - ring.top + 6));
			return { left, bottom };
		}

		/**
		 * How the ring sits against the account row: does it intersect, and is it on the
		 * same band? Pure, so the acceptance rule is asserted instead of eyeballed.
		 */
		function ringPlacement(row, ring) {
			const overlap = !(ring.right <= row.left || ring.left >= row.right || ring.bottom <= row.top || ring.top >= row.bottom);
			const dy = Math.abs((ring.top + ring.height / 2) - (row.top + row.height / 2));
			const dx = ring.left - row.right;
			return { overlap, dy, dx };
		}

		/** One-line summary for the row's accessible name: `OpenCode Go · 5h 3% …`. */
		function usageSummary(usage, t) {
			const parts = ["OpenCode Go"];
			for (const key of usageWindows(usage)) {
				const view = usage[key];
				const unit = t(`usage.short.${key}`);
				const left = typeof view.percent === "number" ? Math.max(0, 100 - Math.max(0, Math.min(100, view.percent))) : null;
				const percent = formatPercent(left);
				parts.push(unit === `usage.short.${key}` ? percent : `${unit} ${percent}`);
			}
			return parts.join(" · ");
		}
		/**
		 * One shared usage store behind the row, the panel and the hover hint.
		 * One probe result, one poller, no duplicate traffic.
		 */
		function createUsageStore() {
			let state = { status: "idle", usage: null, fetchedAt: null, code: null, error: null, cached: false };
			const listeners = new Set();
			let inFlight = null;
			const emit = () => {
				for (const listener of listeners) listener();
			};
			const set = (patch) => {
				state = { ...state, ...patch };
				emit();
			};
			const read = ({ force = false } = {}) => {
				if (inFlight !== null) return inFlight;
				const promise = requestJson(`${API.usage}${force ? "?refresh=1" : ""}`)
					.then(({ json }) => {
						if (json && json.ok === true && json.usage) {
							set({
								status: "ok",
								usage: json.usage,
								fetchedAt: typeof json.fetchedAt === "number" ? json.fetchedAt : Date.now(),
								code: null,
								error: null,
								cached: json.cached === true
							});
							return;
						}
						// Stale beats amnesia: a failed probe keeps the last good
						// numbers on screen and reports the failure beside them.
						const last = json && json.last && json.last.windows ? json.last.windows : state.usage;
						set({
							status: "error",
							code: json && typeof json.code === "string" ? json.code : "unavailable",
							error: json && typeof json.error === "string" ? json.error : null,
							usage: last,
							fetchedAt: json && json.last && typeof json.last.fetchedAt === "number" ? json.last.fetchedAt : state.fetchedAt
						});
					})
					.catch((error) => {
						set({ status: "error", code: "network", error: String((error && error.message) || error) });
					})
					.finally(() => {
						if (inFlight === promise) inFlight = null;
					});
				inFlight = promise;
				if (state.status === "idle") set({ status: "loading" });
				return promise;
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getSnapshot: () => state,
				read
			};
		}

		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout. Style objects cannot be lost that
		// way. Colours come from the theme tokens so light and dark both hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped menu's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		// Inline styles, not a stylesheet: this section is rendered inside the
		// shipped shell's own DOM, where a missed <style> injection or a cascade
		// rule silently flattens the layout (it did once). Style objects cannot be
		// lost that way. Colours come from the theme tokens so light and dark hold.
		const USAGE_COLOR = {
			primary: "var(--dsw-alias-label-primary, CanvasText)",
			secondary: "var(--dsw-alias-label-secondary, #8b8b8b)",
			error: "var(--dsw-alias-state-error-primary, #c95d5d)"
		};

		/** One card at a time; the id is stable so the ring can point at it. */
		const USAGE_CARD_ID = "ocgp-usage-card";

		/** Where the console lives; the card offers a shortcut, never an embed. */
		const USAGE_CONSOLE_URL = "https://opencode.ai/console/";

		// The affordance is ONE persistent ring at the sidebar foot, right-aligned
		// with the account row: the top arc is the 5-hour window, the bottom arc the
		// week, OpenCode's mark in the hole. Monochrome on purpose — the arc length
		// carries the amount, and a passive reading does not get a hue.
		const RING = { size: 32, center: 16, radius: 12, stroke: 3.2, hit: 12 };
		// Written out rather than computed: 13 - 9.6 would render as 3.4000000000000004.
		// 14° of air at each seam (12 o'clock and 6 o'clock), round caps: two capsule
		// arcs rather than a broken circle.
		const RING_UP = "M4.4 13.1 A12 12 0 0 1 27.6 13.1";
		const RING_DOWN = "M27.6 18.9 A12 12 0 0 1 4.4 18.9";

		const USAGE_STYLE = {
			// The ring sits in the sidebar foot's settings row, absolutely placed so it
			// cannot disturb that row's own layout.
			// A flex child of the account row: margin-left pushes it right, and the row's
			// own align-items centres it, so it can never overlap the avatar or the name.
			// Pinned to the row's right edge. A flex child depends on which wrapper the
			// shell happens to use (measured: the row stayed 260px wide), so the ring
			// positions itself and the row only provides the containing block.
			host: {
				position: "absolute",
				// "12px", not 12: this object goes through Object.assign(host.style, …),
				// where a bare number becomes an invalid value and is silently dropped.
				right: "12px",
				top: "50%",
				transform: "translateY(-50%)",
				display: "inline-flex",
				alignItems: "center",
				zIndex: 5
			},
			button: {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 40,
				height: 40,
				padding: 0,
				border: 0,
				borderRadius: 8,
				background: "none",
				color: USAGE_COLOR.secondary,
				cursor: "pointer"
			},
			buttonEmpty: { color: USAGE_COLOR.secondary, opacity: 0.55 },
			// Same material as the shipped menus: a rounded, hairline-bordered shell with
			// the menu surface drawn by an inset layer (inline styles cannot use ::before,
			// so the layer is a real child).
			card: {
				position: "fixed",
				zIndex: 2147483000,
				width: 248,
				maxWidth: "calc(100vw - 16px)",
				boxSizing: "border-box",
				padding: 8,
				borderRadius: "var(--dsw-radius-lg, 12px)",
				border: ".5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))",
				boxShadow: "var(--dsw-shadow-lv3, 0 10px 30px rgba(0, 0, 0, 0.32))",
				fontSize: 14,
				lineHeight: "22px",
				color: "var(--dsw-alias-label-primary, CanvasText)"
			},
			cardMaterial: {
				position: "absolute",
				inset: 0,
				zIndex: -1,
				borderRadius: "inherit",
				background: "var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, #222))",
				backdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
				pointerEvents: "none"
			},
			cardHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6, padding: "2px 8px 0" },
			cardTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, lineHeight: "18px", color: USAGE_COLOR.secondary },
			consoleButton: {
				flex: "none",
				marginLeft: "auto",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: 24,
				height: 24,
				padding: 0,
				border: 0,
				borderRadius: 6,
				background: "none",
				color: USAGE_COLOR.secondary,
				cursor: "pointer"
			},
			grid: {
				display: "grid",
				gridTemplateColumns: "minmax(0, 1fr) auto auto",
				columnGap: 8,
				rowGap: 0,
				alignItems: "baseline"
			},
			window: { display: "contents" },
			cell: { padding: "4px 8px" },
			name: {
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontSize: 13,
				fontWeight: 500,
				color: USAGE_COLOR.primary
			},
			percent: {
				fontSize: 13,
				fontWeight: 600,
				color: USAGE_COLOR.primary,
				fontVariantNumeric: "tabular-nums",
				textAlign: "right",
				whiteSpace: "nowrap"
			},
			reset: {
				fontSize: 12,
				color: USAGE_COLOR.secondary,
				fontVariantNumeric: "tabular-nums",
				textAlign: "right",
				whiteSpace: "nowrap"
			},
			limited: { fontSize: 12, color: USAGE_COLOR.secondary, whiteSpace: "nowrap" },
			rule: { height: 0, borderTop: ".5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))", margin: "6px 8px" },
			foot: { marginTop: 4, padding: "0 8px 2px", fontSize: 11, color: USAGE_COLOR.secondary, lineHeight: "16px" },
			footError: { marginTop: 4, padding: "0 8px 2px", fontSize: 11, color: USAGE_COLOR.error, lineHeight: "16px" }
		};

		/** The ring's hover tooltip; positioned by the button on every hover. */
		const USAGE_BUBBLE_STYLE = {
			position: "fixed",
			zIndex: 2147483001,
			maxWidth: 240,
			padding: "5px 8px",
			borderRadius: 7,
			fontSize: 11.5,
			lineHeight: 1.4,
			whiteSpace: "pre-line",
			pointerEvents: "none",
			opacity: 1,
			color: USAGE_COLOR.primary,
			background: "var(--dsw-alias-bg-overlay, #222)",
			border: "1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.24))",
			boxShadow: "0 6px 20px rgba(0, 0, 0, 0.28)"
		};

		/**
		 * The ring and the card live in two different React roots (the ring must sit in
		 * the shipped sidebar foot; the card must be outside it), so they coordinate
		 * through this tiny store instead of through props.
		 */
		function createCardStore() {
			let state = { open: false, anchor: null, tip: null };
			const listeners = new Set();
			const emit = () => {
				for (const listener of listeners) listener();
			};
			return {
				toggle(anchor) {
					state = state.open ? { open: false, anchor: null, tip: null } : { open: true, anchor, tip: null };
					emit();
				},
				close() {
					if (!state.open) return;
					state = { open: false, anchor: null, tip: null };
					emit();
				},
				// Hover reading: drawn by the body-mounted root, because the ring's host is
				// transformed and would become the containing block of a fixed child.
				setTip(tip) {
					state = { ...state, tip };
					emit();
				},
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}

		/** OpenCode's mark as a line-art glyph in `currentColor`. */
		function UsageBrandMark({ size = 16 }) {
			return react_jsx_runtime.jsxs("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": 1.4,
				"stroke-linejoin": "miter",
				"aria-hidden": "true",
				children: [
					react_jsx_runtime.jsx("rect", { x: 4, y: 3, width: 8, height: 10 }),
					react_jsx_runtime.jsx("rect", { x: 6, y: 7, width: 4, height: 4, fill: "currentColor", stroke: "none" })
				]
			});
		}

		/** External-link glyph for the console shortcut. */
		function UsageExternalIcon() {
			return react_jsx_runtime.jsxs("svg", {
				viewBox: "0 0 16 16",
				width: 14,
				height: 14,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": 1.4,
				"aria-hidden": "true",
				children: [
					react_jsx_runtime.jsx("path", { d: "M9.5 3h3.5v3.5", "stroke-linecap": "round", "stroke-linejoin": "round" }),
					react_jsx_runtime.jsx("path", { d: "M13 3L7.5 8.5", "stroke-linecap": "round" }),
					react_jsx_runtime.jsx("path", { d: "M12 9.8V13H3V4h3.2", "stroke-linecap": "round", "stroke-linejoin": "round" })
				]
			});
		}

		/** The two-half ring: top arc = 5h, bottom arc = week, mark in the hole. */
		function UsageRing({ rolling, weekly, muted, hovered, onHover, reduced }) {
			// The arc is HEADROOM, not spend: a new window is full, a spent one empty. That
			// is the question a passers-by actually asks ("can I keep going?"), and it
			// keeps "full ring" and "plenty left" the same idea.
			const remaining = (value) => (typeof value === "number" ? Math.max(0, 100 - Math.max(0, Math.min(100, value))) : null);
			const half = (value, path, key) => {
				const headroom = remaining(value);
				const clamped = headroom === null ? 0 : headroom;
				const active = hovered === key;
				return react_jsx_runtime.jsxs("g", {
					children: [
						react_jsx_runtime.jsx("path", {
							d: path,
							fill: "none",
							stroke: "currentColor",
							strokeOpacity: muted ? 0.24 : 0.16,
							strokeDasharray: muted ? "2 4" : undefined,
							strokeWidth: RING.stroke,
							strokeLinecap: "round"
						}),
						muted ? null : react_jsx_runtime.jsx("path", {
							d: path,
							fill: "none",
							pathLength: 100,
							strokeDasharray: `${clamped} 100`,
							// Monochrome on purpose: arc length carries the amount, and no hue
							// asks for attention a passive reading does not deserve.
							stroke: "currentColor",
							strokeOpacity: headroom === null ? 0.3 : 1,
							strokeWidth: active ? RING.stroke + 0.9 : RING.stroke,
							strokeLinecap: "round",
							style: { transition: reduced ? "none" : "stroke-width .12s ease" }
						}),
						// A fat transparent twin is the hover target: a 2.6px arc is
						// impossible to point at reliably.
						muted ? null : react_jsx_runtime.jsx("path", {
							d: path,
							fill: "none",
							stroke: "transparent",
							strokeWidth: RING.hit,
							onMouseEnter: (event) => onHover(key, event.currentTarget.getBoundingClientRect()),
							onMouseLeave: () => onHover(null, undefined)
						})
					]
				}, key);
			};
			return react_jsx_runtime.jsxs("svg", {
				viewBox: `0 0 ${RING.size} ${RING.size}`,
				width: RING.size,
				height: RING.size,
				"aria-hidden": "true",
				"data-ocgp": "usage-ring",
				style: { overflow: "visible" },
				children: [
					half(typeof rolling === "number" ? rolling : null, RING_UP, "rolling"),
					half(typeof weekly === "number" ? weekly : null, RING_DOWN, "weekly"),
					react_jsx_runtime.jsx("g", {
						transform: `translate(${(RING.size - 12) / 2} ${(RING.size - 12) / 2}) scale(0.75)`,
						children: react_jsx_runtime.jsx(UsageBrandMark, { size: 16 })
					})
				]
			});
		}

		/**
		 * The one control: a ring in the sidebar foot.
		 *
		 * It carries `aria-expanded`/`aria-controls`; there is no menuitem role to worry
		 * about because it no longer lives inside the account menu. With no credential
		 * it does not open a card at all — it goes straight to the plugin's settings
		 * card, where the key field lives.
		 */
		function UsageRingButton({ store, cards, t, locale, onOpenSettings }) {
			const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const cardState = react.useSyncExternalStore(cards.subscribe, cards.getSnapshot, cards.getSnapshot);
			const ref = react.useRef(null);
			const reduced = typeof UsageRingButton.reducedMotion === "boolean"
				? UsageRingButton.reducedMotion
				: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
			const usage = state.usage;
			const windows = usageWindows(usage);
			const rolling = usage === null || typeof usage !== "object" ? undefined : usage.rolling;
			const weekly = usage === null || typeof usage !== "object" ? undefined : usage.weekly;
			const noCredential = state.code === "no-key" || state.code === "auth";
			// "Empty" means no headroom left: a capped window is either flagged by the
			// gateway or already at 100%, and both read the same on the ring.
			const empty = windows.length > 0 && windows.some((key) => {
				const view = usage[key];
				if (view === null || typeof view !== "object") return false;
				return view.status === "rate-limited" || (typeof view.percent === "number" && view.percent >= 100);
			});
			const muted = noCredential || empty;
			const onHover = (key, rect) => {
				if (key === null || rect === undefined) {
					cards.setTip(null);
					return;
				}
				cards.setTip({
					key,
					text: hoverReading(
						key,
						typeof rolling?.percent === "number" ? rolling.percent : null,
						typeof weekly?.percent === "number" ? weekly.percent : null,
						t
					),
					left: Math.max(8, Math.round(rect.left - 12)),
					bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8))
				});
			};
			const activate = () => {
				// No credential is not a detail state, it is a setup state: one hop to the
				// place that owns the field, never a dead-end card.
				if (noCredential) {
					if (typeof onOpenSettings === "function") onOpenSettings();
					return;
				}
				const node = ref.current;
				if (node === null) return;
				const rect = node.getBoundingClientRect();
				cards.toggle(cardAnchor(rect, { width: window.innerWidth, height: window.innerHeight }));
				if (!cardState.open) void store.read({ force: true });
			};
			const label = noCredential
				? t("usage.connect")
				: `${t("usage.title")}: ${usageSummary(usage, t)}`;
			return react_jsx_runtime.jsxs(react.Fragment, {
				children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						ref,
						style: muted ? { ...USAGE_STYLE.button, ...USAGE_STYLE.buttonEmpty } : USAGE_STYLE.button,
						"aria-expanded": noCredential ? undefined : cardState.open,
						"aria-controls": noCredential ? undefined : USAGE_CARD_ID,
						"aria-label": label,
						title: noCredential ? t("usage.connect") : undefined,
						"data-ocgp": "usage-ring-button",
						"data-state": noCredential ? "unconfigured" : empty ? "empty" : "ok",
						onClick: (event) => {
							event.preventDefault();
							event.stopPropagation();
							activate();
						},
						children: react_jsx_runtime.jsx(UsageRing, {
							rolling: typeof rolling?.percent === "number" ? rolling.percent : null,
							weekly: typeof weekly?.percent === "number" ? weekly.percent : null,
							muted,
							hovered: cardState.tip === null || cardState.tip === undefined ? null : cardState.tip.key,
							onHover,
							reduced
						})
					}),
					null
				]
			});
		}

		/** The card: three windows, a console shortcut, a freshness line. */
		function UsageCard({ store, cards, t, locale }) {
			const cardState = react.useSyncExternalStore(cards.subscribe, cards.getSnapshot, cards.getSnapshot);
			const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const open = cardState.open;
			// Dismissal lives with the layer: Escape and an outside click close it.
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") cards.close();
				};
				const onDown = (event) => {
					const target = event.target instanceof Element ? event.target : null;
					if (target === null) return;
					if (target.closest('[data-ocgp="usage-card"]') !== null) return;
					if (target.closest('[data-ocgp="usage-ring-button"]') !== null) return;
					cards.close();
				};
				document.addEventListener("keydown", onKey, true);
				document.addEventListener("mousedown", onDown, true);
				return () => {
					document.removeEventListener("keydown", onKey, true);
					document.removeEventListener("mousedown", onDown, true);
				};
			}, [open, cards]);
			const tip = cardState.tip;
			const tipNode = tip === null || tip === undefined ? null : react_jsx_runtime.jsx("div", {
				role: "tooltip",
				"data-ocgp": "usage-tip",
				style: {
					position: "fixed",
					zIndex: 2147483001,
					maxWidth: 240,
					padding: "5px 8px",
					borderRadius: 7,
					fontSize: 11.5,
					lineHeight: 1.4,
					whiteSpace: "pre-line",
					pointerEvents: "none",
					color: "var(--dsw-alias-label-primary, CanvasText)",
					background: "var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay, #222))",
					backdropFilter: "var(--dsw-menu-backdrop-filter, blur(20px))",
					border: ".5px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))",
					boxShadow: "var(--dsw-shadow-lv3, 0 6px 20px rgba(0, 0, 0, 0.28))",
					left: tip.left,
					bottom: tip.bottom
				},
				children: tip.text
			});
			if (!open) return tipNode;
			const usage = state.usage;
			const windows = usageWindows(usage);
			const now = Date.now();
			const updatedAt = formatUpdatedAt(state.fetchedAt, locale);
			const statusText = state.status === "ok"
				? updatedAt === null ? null : t("usage.updatedAt", { time: updatedAt })
				: state.code === "no-key"
					? t("usage.noKey")
					: state.code === "auth"
						? t("usage.auth")
						: state.status === "error" ? t("usage.unavailable") : t("usage.loading");
			const anchor = cardState.anchor;
			const cardNode = react_jsx_runtime.jsxs("div", {
				id: USAGE_CARD_ID,
				role: "group",
				"aria-label": t("usage.title"),
				"data-ocgp": "usage-card",
				style: anchor === null
					? { ...USAGE_STYLE.card, position: "static", width: "auto" }
					: { ...USAGE_STYLE.card, left: anchor.left, bottom: anchor.bottom },
				children: [
					react_jsx_runtime.jsx("div", { style: USAGE_STYLE.cardMaterial, "data-ocgp": "usage-material", "aria-hidden": "true" }),
					react_jsx_runtime.jsxs("div", {
						style: USAGE_STYLE.cardHead,
						children: [
							react_jsx_runtime.jsx("span", { style: USAGE_STYLE.cardTitle, children: t("usage.title") }),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: USAGE_STYLE.consoleButton,
								title: t("usage.console"),
								"aria-label": t("usage.console"),
								"data-ocgp": "usage-console",
								onClick: (event) => {
									event.preventDefault();
									event.stopPropagation();
									if (typeof window !== "undefined" && typeof window.open === "function") {
										window.open(USAGE_CONSOLE_URL, "_blank", "noopener,noreferrer");
									}
								},
								children: react_jsx_runtime.jsx(UsageExternalIcon, {})
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: USAGE_STYLE.grid,
						role: "table",
						"data-ocgp": "usage-grid",
						children: windows.map((key) => {
							const view = usage[key];
							const percent = typeof view.percent === "number" && Number.isFinite(view.percent) ? view.percent : null;
							const limited = view.status === "rate-limited" || (typeof percent === "number" && percent >= 100);
							const stamp = typeof view.resetsAt === "string" ? new Date(view.resetsAt) : undefined;
							const name = t(`usage.window.${key}`);
							const reset = formatResetValue(view.resetsAt, now, locale, t);
							return react_jsx_runtime.jsxs("div", {
								style: USAGE_STYLE.window,
								role: "row",
								"data-window": key,
								"data-state": limited ? "limited" : "ok",
								children: [
									react_jsx_runtime.jsx("span", {
										role: "cell",
										style: { ...USAGE_STYLE.cell, ...USAGE_STYLE.name },
										dir: "auto",
										title: name,
										children: name
									}),
									react_jsx_runtime.jsx("span", {
										role: "cell",
										"aria-label": t("usage.percentAria", { percent: formatPercent(percent) }),
										style: { ...USAGE_STYLE.cell, ...USAGE_STYLE.percent },
										children: formatPercent(percent)
									}),
									react_jsx_runtime.jsx("span", {
										role: "cell",
										style: { ...USAGE_STYLE.cell, ...(limited ? USAGE_STYLE.limited : USAGE_STYLE.reset) },
										title: stamp === undefined ? undefined : stamp.toLocaleString(),
										children: limited ? t("usage.limited") : reset
									})
								]
							}, key);
						})
					}),
					statusText === null ? null : react_jsx_runtime.jsx("div", {
						style: state.status === "ok" ? USAGE_STYLE.foot : USAGE_STYLE.footError,
						"data-ocgp": "usage-freshness",
						"aria-live": "polite",
						children: statusText
					})
				]
			});
			return react_jsx_runtime.jsxs(react.Fragment, { children: [tipNode, cardNode] });
		}
		/**
		 * Mount the usage ring as a normal flex child of the account row, and the card
		 * on document.body.
		 *
		 * Placement is a LAYOUT decision, not pixel surgery: the ring joins the row's
		 * flex flow (margin-left:auto), so it cannot overlap the avatar or the name at
		 * any width. After mount the ring measures itself against the launcher; if the
		 * shell ever changes enough that the two collide, it falls back to the shipped
		 * `sidebar.footer.action` row instead of drawing on top of the account row.
		 */
		function installSidebarUsage(ctx, t) {
			if (typeof document === "undefined" || typeof window === "undefined" || document.body === null) return () => {};
			if (react_dom_client === null || typeof react_dom_client.createRoot !== "function") {
				if (typeof console !== "undefined") console.warn("dsh-opencode-go-plus: react-dom/client unavailable — sidebar usage ring skipped");
				return () => {};
			}
			const activeLocale = () => {
				try {
					const snapshot = ctx?.locale?.getLocale?.();
					return typeof snapshot?.active === "string" ? snapshot.active : undefined;
				} catch {
					return undefined;
				}
			};
			const store = createUsageStore();
			const cards = createCardStore();
			const openSettings = () => {
				try {
					const layout = ctx.get?.("layout");
					if (layout !== undefined && typeof layout.selectPanel === "function") layout.selectPanel("plugins");
				} catch {
					// no layout service: the ring simply has no hop
				}
			};
			void store.read();

			const cardHost = document.createElement("div");
			cardHost.setAttribute("data-ocgp", "usage-card-host");
			cardHost.style.display = "contents";
			document.body.appendChild(cardHost);
			const cardRoot = react_dom_client.createRoot(cardHost);
			cardRoot.render(react_jsx_runtime.jsx(UsageCard, { store, cards, t, locale: activeLocale() }));

			let root = null;
			let host = null;
			let rowHome = null;
			let savedDisplay = "";
			let savedAlign = "";
			let savedFlex = "";
			let savedMinWidth = "";
			let savedWidth = "";
			let savedPosition = "";
			let fallback = false;
			let launcher = null;
			let scheduled = false;
			let disposed = false;

			const isBottomLeft = (element) => {
				const rect = element.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return false;
				return rect.left < window.innerWidth * 0.45 && rect.top > window.innerHeight * 0.55;
			};
			const findTrigger = () => {
				for (const element of document.querySelectorAll('button[aria-haspopup="menu"][data-collapsed]')) {
					if (isBottomLeft(element)) return element;
				}
				return null;
			};
			// The account row is the block the launcher sits in; the footer-actions row is
			// the fallback seat when that block cannot take a flex child.
			// Pick the row by GEOMETRY, not by class name: the class selectors do not exist
			// in the shipped markup (measured: the fallback landed on a ~52px wrapper, so
			// right:10 put the ring on top of the avatar). The account row is the nearest
			// ancestor that is actually a row wide.
			const ROW_MIN_WIDTH = 140;
			const findAccountRow = (trigger) => {
				let node = trigger.parentElement;
				while (node !== null && node !== document.body) {
					const rect = node.getBoundingClientRect();
					if (rect.width >= ROW_MIN_WIDTH && rect.height >= 20 && rect.height <= 96) return node;
					node = node.parentElement;
				}
				const byClass = trigger.closest('[class*="settingsArea"]');
				return byClass === null ? trigger.parentElement : byClass;
			};
			const findFooterRow = () => document.querySelector('[class*="footerActions"]');

			// The rail is 56px wide with a 36px avatar button, so a 40px ring cannot sit
			// beside it: in the rail the ring steps aside instead of overlapping.
			const RAIL_WIDTH = 72;
			const applyRail = (container) => {
				if (host === null || container === null) return;
				const width = container.getBoundingClientRect().width;
				const rail = width > 0 && width < RAIL_WIDTH;
				host.style.display = rail ? "none" : "inline-flex";
				host.dataset.rail = rail ? "true" : "false";
			};
			const onResize = () => {
				if (rowHome !== null) applyRail(rowHome);
			};
			const unmountRing = () => {
				if (root !== null) {
					try {
						root.unmount();
					} catch {
						// the shell may have removed the node first
					}
					root = null;
				}
				if (host !== null) {
					host.remove();
					host = null;
				}
				if (launcher !== null) {
					launcher.style.flex = savedFlex;
					launcher.style.minWidth = savedMinWidth;
					launcher.style.width = savedWidth;
					launcher = null;
				}
				if (rowHome !== null) {
					rowHome.style.display = savedDisplay;
					rowHome.style.alignItems = savedAlign;
					rowHome.style.position = savedPosition;
					rowHome = null;
				}
			};
			const detach = () => {
				cards.close();
				unmountRing();
				fallback = false;
			};
			const mountInto = (container, trigger) => {
				rowHome = container;
				savedDisplay = container.style.display;
				savedAlign = container.style.alignItems;
				savedPosition = container.style.position;
				if (getComputedStyle(container).position === "static") container.style.position = "relative";
				// A flex row is what makes this a layout member rather than an overlay.
				if (getComputedStyle(container).display !== "flex") {
					container.style.display = "flex";
					container.style.alignItems = "center";
				}
				// The launcher ships as width:100%; inside a flex row that leaves the ring
				// no space at all (measured: dx=-2, ring overflowing the column). Let it
				// shrink like any other menu row and ellipsize its label instead.
				// The flex child is not the button itself: the launcher sits inside the Menu's
				// wrapper span, and shrinking the button does nothing while that span is the
				// item (measured: the row stayed 260px wide). Shrink the direct child instead.
				if (trigger !== null && trigger !== undefined) {
					let item = trigger;
					while (item.parentElement !== null && item.parentElement !== container) item = item.parentElement;
					launcher = item;
					savedFlex = item.style.flex;
					savedMinWidth = item.style.minWidth;
					savedWidth = item.style.width;
					item.style.flex = "1 1 auto";
					item.style.minWidth = "0";
					item.style.width = "auto";
				}
				host = document.createElement("div");
				host.setAttribute("data-ocgp", "usage-ring-host");
				Object.assign(host.style, USAGE_STYLE.host);
				// Belt and braces: the CSSOM drops unitless numbers, so state the offsets.
				host.style.position = "absolute";
				host.style.right = "12px";
				host.style.top = "50%";
				host.style.transform = "translateY(-50%)";
				container.appendChild(host);
				root = react_dom_client.createRoot(host);
				root.render(react_jsx_runtime.jsx(UsageRingButton, {
					store,
					cards,
					t,
					locale: activeLocale(),
					onOpenSettings: openSettings
				}));
				applyRail(container);
			};
			// Measure once after layout: same band as the launcher, no intersection.
			// One report, sent after the seat is decided: the numbers a reader sees must
			// describe where the ring actually ended up.
			const report = (rowRect, onAccountRow) => {
				const rect = host === null ? null : host.getBoundingClientRect();
				if (rect === null) return;
				const seat = onAccountRow && !fallback ? "account-row" : "footer";
				try {
					void fetch(API.ringReport, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							viewport: { width: window.innerWidth, height: window.innerHeight },
							row: { left: Math.round(rowRect.left), top: Math.round(rowRect.top), width: Math.round(rowRect.width), height: Math.round(rowRect.height) },
							ring: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
							overlap: ringPlacement(rowRect, rect).overlap,
							dx: Math.round(rect.left - rowRect.right),
							gap: Math.round(rect.left - rowRect.left),
							box: rowHome === null ? null : { left: Math.round(rowHome.getBoundingClientRect().left), width: Math.round(rowHome.getBoundingClientRect().width) },
							inside: rect.right <= rowRect.right - 2,
							dy: Math.round(Math.abs((rect.top + rect.height / 2) - (rowRect.top + rowRect.height / 2))),
							seat
						})
					}).catch(() => {});
				} catch {
					// diagnostics never break the ring
				}
				if (typeof console !== "undefined") {
					const check = ringPlacement(rowRect, rect);
					console.debug(`[ring] row=${Math.round(rowRect.width)}x${Math.round(rowRect.height)} ring=${Math.round(rect.width)}x${Math.round(rect.height)} overlap=${check.overlap ? 1 : 0} dx=${Math.round(check.dx)} dy=${Math.round(check.dy)} seat=${seat}`);
				}
			};
			// The React root paints a frame later, so an early check sees width 0 and would
			// "detect" an overlap that does not exist (measured: ring=0@12). Wait for real
			// layout before judging; give up quietly rather than degrade on a false read.
			const selfCheck = (trigger, attempt = 0) => {
				if (host === null) return;
				if (host.dataset.rail === "true") return;
				const measured = host.getBoundingClientRect();
				if (measured.width < 8) {
					if (attempt < 20) {
						if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => selfCheck(trigger, attempt + 1));
						else setTimeout(() => selfCheck(trigger, attempt + 1), 16);
					}
					return;
				}
				const rowRect = trigger.getBoundingClientRect();
				const rect = measured;
				// Where the ring MUST be: inside the row's right edge (it is pinned at
				// right:10) and on the row's vertical centre. Judging against the button's
				// own box is wrong — the button spans the row — and probing for class names
				// is brittle (measured: no [class*="avatar"] in the shipped markup, so the
				// ring was compared with the full-width button and always "collided").
				const gap = Math.round(rect.left - rowRect.right);
				const insideRow = rect.left >= rowRect.left && rect.right <= rowRect.right - 2;
				const dy = Math.abs((rect.top + rect.height / 2) - (rowRect.top + rowRect.height / 2));
				if (!insideRow || dy > 2) {
					unmountRing();
					const footer = findFooterRow();
					if (footer !== null) {
						fallback = true;
						mountInto(footer, null);
						if (typeof console !== "undefined") console.warn("dsh-opencode-go-plus: account row refused the ring, using the footer actions row");
						if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => report(rowRect, false));
						else setTimeout(() => report(rowRect, false), 16);
					} else {
						detach();
					}
					return;
				}
				report(rowRect, true);
			};
			const attach = (trigger) => {
				if (host !== null && host.isConnected) return;
				const row = findAccountRow(trigger);
				if (row === null) return;
				fallback = false;
				mountInto(row, trigger);
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => selfCheck(trigger));
				else setTimeout(() => selfCheck(trigger), 16);
				void store.read();
			};
			const scan = () => {
				scheduled = false;
				if (disposed) return;
				const trigger = findTrigger();
				if (trigger === null) {
					detach();
					return;
				}
				if (host !== null && host.isConnected) return;
				attach(trigger);
			};
			const schedule = () => {
				if (scheduled || disposed) return;
				scheduled = true;
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(scan);
				else setTimeout(scan, 16);
			};
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "class"] });
			window.addEventListener("resize", onResize);

			const timer = setInterval(() => {
				if (document.visibilityState === "visible") void store.read();
			}, 180_000);
			schedule();

			return () => {
				disposed = true;
				observer.disconnect();
				window.removeEventListener("resize", onResize);
				clearInterval(timer);
				detach();
				try {
					cardRoot.unmount();
				} catch {
					// already gone
				}
				cardHost.remove();
			};
		}


		// ── cordis plugin entry ──
		// `locale` is injected so the card follows the harness language.
		//
		// DSH <= 0.1.6 renders plugin-owned configuration through
		// `settings.plugin.item`. DSH >= 0.1.7 moved bundle configuration to
		// `plugins.bundle.config`: the old slot remains harmlessly pending on a
		// current client, while the new slot is absent on an older client. Keep
		// both registrations so upgrading DSH never turns the model picker into
		// a read-only provider list again.
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-opencode-go-plus: dictionaries");
			const t = ctx.locale.bind(NS);
			// The ring is a runtime addition to the shipped sidebar foot, not a slot
			// registration; the effect owns its teardown.
			ctx.effect(() => installSidebarUsage(ctx, t), "dsh-opencode-go-plus: sidebar usage ring");
			const renderCard = (props) => {
				const translate = typeof props?.t === "function" ? props.t : t;
				// Bundle configuration currently requests only `page`, but returning a
				// short summary makes this safe if a future Plugins page also asks for
				// a compact view.
				if (props?.view === "summary") return translate("desc");
				return ModelsCard({ ...(props || {}), t: translate });
			};
			ctx.effect(() => {
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "dsh-opencode-go-plus"
				}, renderCard));
			}, "dsh-opencode-go-plus: legacy plugin card registration");
			ctx.effect(() => {
				ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-opencode-go-plus",
					locale: NS
				}, renderCard));
			}, "dsh-opencode-go-plus: bundle configuration registration");
		}

		exports.apply = apply;
		exports.inject = inject;
		// exposed so tests can resolve the same strings the card renders
		exports.dictionaries = { zh, en };
		// exposed so the usage formatting is testable without a DOM
		exports.usageFormat = {
			USAGE_WINDOWS,
			formatPercent,
			usageWindows,
			formatResetValue,
			formatUpdatedAt,
			hoverReading,
			usageSummary,
			cardAnchor,
			ringPlacement
		};
		// exposed so the panel can be rendered to static HTML (docs preview, tests)
		exports.usageRingButton = UsageRingButton;
		// the card is a separate root; the demo and tests render it directly
		exports.usageCard = UsageCard;
		exports.createCardStore = createCardStore;
		return module.exports;
	}
});