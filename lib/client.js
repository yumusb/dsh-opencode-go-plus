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
			"check.dropped": "已从选择中移除：{ids}。点「启用所选」保存。",
			"check.drop": "移除这些模型",
			"row.undocumented": "目录未收录",
			"btn.fetching": "获取中…",
			"btn.fetch": "获取可用模型",
			"btn.refetch": "重新获取",
			"search.placeholder": "搜索模型",
			"count": "已选 {picked} / {total}",
			"count.visible": "已选 {picked} / {total} · 显示 {visible}",
			"filter.label": "筛选模型",
			"filter.all": "全部",
			"filter.on": "已启用",
			"filter.off": "未启用",
			"sel.allVisible": "全选显示项",
			"sel.all": "全选",
			"sel.invert": "反选",
			"sel.clearVisible": "取消显示项",
			"sel.clear": "清空",
			"row.enabled": "当前已启用",
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
			"check.dropped": "Removed from the selection: {ids}. Click \"Enable selected\" to save.",
			"check.drop": "Remove these models",
			"row.undocumented": "Not in catalog",
			"btn.fetching": "Fetching…",
			"btn.fetch": "Fetch available models",
			"btn.refetch": "Refresh list",
			"search.placeholder": "Search models",
			"count": "{picked} / {total} selected",
			"count.visible": "{picked} / {total} selected · {visible} shown",
			"filter.label": "Filter models",
			"filter.all": "All",
			"filter.on": "Enabled",
			"filter.off": "Disabled",
			"sel.allVisible": "Select shown",
			"sel.all": "Select all",
			"sel.invert": "Invert",
			"sel.clearVisible": "Clear shown",
			"sel.clear": "Clear",
			"row.enabled": "Currently enabled",
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
		};

		const API = {
			info: "/dsh-opencode-go-plus/models-info",
			fetch: "/dsh-opencode-go-plus/models-fetch",
			apply: "/dsh-opencode-go-plus/models-apply",
			config: "/dsh-opencode-go-plus/config",
			test: "/dsh-opencode-go-plus/test",
			check: "/dsh-opencode-go-plus/models-check",
			removeRoute: "/dsh-opencode-go-plus/remove-route"
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
				".ocgp-link:disabled{opacity:.4;cursor:default}",
				".ocgp-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:4px;list-style:none;max-height:min(340px,42vh);overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}",
				".ocgp-cand{border-radius:6px;display:flex;align-items:flex-start;gap:8px;padding:6px 8px;cursor:pointer}",
				".ocgp-cand:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".ocgp-cand input{flex:none;margin-top:3px}",
				".ocgp-cand-body{flex:1;min-width:0}",
				".ocgp-cand-id{font-family:var(--ds-font-family-code);font-size:13px;line-height:18px;overflow-wrap:anywhere}",
				".ocgp-cand-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:500}",
				".ocgp-cand-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}"
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

			const loadInfo = react.useCallback(() => {
				requestJson(API.info).then(({ json }) => {
					if (json && json.ok) {
						setInfo(json);
						setConflicts(Array.isArray(json.conflicts) ? json.conflicts : []);
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
				requestJson(API.info).then(({ json }) => {
					if (alive && json && json.ok) {
						setInfo(json);
						setConflicts(Array.isArray(json.conflicts) ? json.conflicts : []);
					}
				});
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

			// Drop the models the check found retired. This edits the selection
			// only, so it still goes through the normal "Enable selected" commit
			// and shows as an unsaved edit first.
			const dropUnavailable = () => {
				const next = new Set(picked);
				for (const id of unavailable) next.delete(id);
				setPicked(next);
				setCheckLine({ ok: true, text: t("check.dropped", { ids: unavailable.join(", ") }) });
				setUnavailable([]);
			};

			const fetchCandidates = async () => {
				setFetching(true);
				setModelLine(null);
				try {
					const { res, json } = await requestJson(API.fetch);
					if (res.status === 0 || !json || json.ok !== true || !Array.isArray(json.candidates)) {
						setModelLine({ ok: false, text: t("fetch.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return;
					}
					if (json.candidates.length === 0) {
						setModelLine({ ok: false, text: t("fetch.empty") });
						return;
					}
					const configured = new Set(Array.isArray(json.configured) ? json.configured : []);
					setCandidates(json.candidates);
					const enabledIds = new Set(json.candidates.filter((c) => configured.has(c.id)).map((c) => c.id));
					setPicked(new Set(enabledIds));
					// the fetched state is the baseline for "unsaved changes"
					setBaseline(enabledIds);
					setVia(json.via ? String(json.via) : null);
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

			const apply = async () => {
				setApplying(true);
				setModelLine(null);
				try {
					const { res, json } = await requestJson(API.apply, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ids: [...picked] })
					});
					if (res.status === 0 || !json || json.ok !== true) {
						setModelLine({ ok: false, text: t("apply.failed", { msg: String((json && json.error) || "HTTP " + res.status) }) });
						return;
					}
					setModelLine({
						ok: true,
						text: json.total === 0
							? t("apply.none")
							: t("apply.ok", { n: json.total })
					});
					// The committed set is the new baseline for change detection —
					// and it is also the new "currently enabled" state. Updating
					// only the baseline left every candidate's `enabled` flag at
					// its pre-apply value, so the scope filter, the row tags and
					// "Discard changes" all worked against the OLD selection:
					// discard after apply silently reverted the committed state.
					const applied = new Set(json.models || []);
					setBaseline(applied);
					setCandidates((current) => current === null
						? null
						: current.map((c) => applied.has(c.id) === c.enabled ? c : { ...c, enabled: applied.has(c.id) }));
					loadInfo();
				} finally {
					setApplying(false);
				}
			};

			const count = info && typeof info.configured === "number" ? info.configured : null;
			const fromCatalog = info && info.fromCatalog === true;
			const stale = info && Array.isArray(info.stale) ? info.stale : [];
			const undocumented = info && Array.isArray(info.undocumented) ? info.undocumented : [];
			const keyConfigured = config && config.keyConfigured === true;
			// what the gateway served when the candidates were fetched
			const configuredIds = candidates === null
				? []
				: candidates.filter((c) => c.enabled).map((c) => c.id);
			const needle = query.trim().toLowerCase();
			const visible = candidates === null ? [] : candidates.filter((c) => {
				if (scope === "on" && !c.enabled) return false;
				if (scope === "off" && c.enabled) return false;
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
										className: "ocgp-btn ocgp-primary",
										onClick: fetchCandidates,
										disabled: fetching || applying,
										children: fetching ? t("btn.fetching") : candidates === null ? t("btn.fetch") : t("btn.refetch")
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
									react_jsx_runtime.jsx("div", {
										className: "ocgp-toolbar-actions",
										children: [
											react_jsx_runtime.jsx("button", {
												type: "button",
												className: "ocgp-link",
												onClick: selectVisible,
												disabled: visible.length === 0 || allVisiblePicked,
												children: t(query.trim().length > 0 || scope !== "all" ? "sel.allVisible" : "sel.all")
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
												children: t(query.trim().length > 0 || scope !== "all" ? "sel.clearVisible" : "sel.clear")
											})
										]
									})
								]
							}) : null,

							modelLine ? react_jsx_runtime.jsx("div", {
								className: modelLine.ok ? "ocgp-line ocgp-ok" : "ocgp-line ocgp-err",
								children: modelLine.text
							}) : null,
							candidates !== null && visible.length > 0
								? react_jsx_runtime.jsx("ul", {
									className: "ocgp-list",
									children: visible.map((c, index) => {
										const boxId = "ocgp-cand-" + index;
										return react_jsx_runtime.jsx("li", {
											children: react_jsx_runtime.jsx("label", {
												className: "ocgp-cand",
												htmlFor: boxId,
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
																className: "ocgp-cand-id",
																children: [
																	c.id,
																	c.enabled ? react_jsx_runtime.jsx("span", {
																		className: "ocgp-tag",
																		children: t("row.enabled")
																	}) : null,
																	c.undocumented === true ? react_jsx_runtime.jsx("span", {
																		className: "ocgp-tag",
																		children: t("row.undocumented")
																	}) : null
																]
															}),
															react_jsx_runtime.jsx("div", { className: "ocgp-cand-name", children: c.name || c.id }),
															react_jsx_runtime.jsx("div", { className: "ocgp-cand-desc", children: candDesc(c, t) })
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

		// ── cordis plugin entry ──
		// `locale` is injected so the card follows the harness language. The
		// `settings.plugin.item` slot takes no `locale` option (only `key`), so
		// the translate function is bound here and handed to the component.
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-opencode-go-plus: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "dsh-opencode-go-plus"
				}, (props) => ModelsCard({ ...(props || {}), t })));
			}, "dsh-opencode-go-plus: plugin card registration");
		}

		exports.apply = apply;
		exports.inject = inject;
		// exposed so tests can resolve the same strings the card renders
		exports.dictionaries = { zh, en };
		return module.exports;
	}
});
