import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { apply, Config, WIRE_PROTOCOLS, inject, namespace } from "../lib/index.js";
import { OpenCodeGoAdapter } from "../lib/adapter.js";
import { catalogEntryFields, catalogIds, displayName, resolveEntry, servedEntries } from "../lib/catalog.js";
import { SUPPORTED_PROTOCOLS, endpointFor, toPiContext, toPiModel } from "../lib/pi-wire.js";

function response() {
	return {
		statusCode: 200,
		headers: {},
		setHeader(name, value) { this.headers[name] = value; },
		end(body = "") { this.body = body; }
	};
}

/**
 * A stub host: enough of `ctx` for `apply()` to mount its settings section,
 * web routes, commands, and LLM registrations without a live harness.
 */
/** Credential writes the host performed during a test (`[ref, value]`). */
let storedCredentials = [];

/**
 * A stand-in for the live `models.dev` document, in its real shape: the
 * provider names its default protocol via `npm`, and a model overrides it with
 * its own `provider.npm`. The host fetches this at mount, so tests need it for
 * any model whose protocol is not written into its stored entry.
 */
const MODELS_DEV_FIXTURE = {
	"opencode-go": {
		npm: "@ai-sdk/openai-compatible",
		models: {
			"deepseek-v4-flash": { name: "DeepSeek V4 Flash", reasoning: true, modalities: { input: ["text"] }, limit: { context: 1000000, output: 384000 } },
			"deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 1000000, output: 384000 }, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
			"glm-5.3-flash": { name: "GLM-5.3-Flash", reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 1000000, output: 131072 }, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
			"omen-alpha": { name: "Omen Alpha", reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 500000, output: 128000 }, reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] },
			// only this one answers the Anthropic wire
			"union-alpha": { name: "Union Alpha Free", reasoning: true, provider: { npm: "@ai-sdk/anthropic" }, modalities: { input: ["text", "image"] }, limit: { context: 262144, output: 131072 } },
			// and this one only the Responses API
			"grok-4.6": { name: "Grok 4.6", reasoning: true, provider: { npm: "@ai-sdk/openai" }, modalities: { input: ["text", "image"] }, limit: { context: 500000, output: 500000 } }
		}
	}
};

function host({ credential = "secret", registered = [], models = [{ id: "deepseek-v4-flash" }], configurable = [], userSections = {}, settingsApi = "legacy" } = {}) {
	storedCredentials = [];
	// The mount fetches metadata in the background. Answer models.dev locally so
	// tests are hermetic and stored entries pick up their wire protocol, while
	// forwarding every gateway call to whatever fetch the test installed (or the
	// real one), so per-test mocks still see the requests they assert on.
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		if (String(url).includes("models.dev")) {
			return { ok: true, status: 200, json: async () => MODELS_DEV_FIXTURE };
		}
		return previousFetch(url, init);
	};
	const routes = new Map();
	const commands = new Map();
	const updates = [];
	/** Writes this plugin performed on OTHER namespaces (`settings.replace`). */
	const replaced = [];
	/** Everything the plugin logged, so a warning can be asserted. */
	const warnings = [];
	/** What `settings.describe()` reports — the raw user layers. */
	const describeResult = Object.entries(userSections).map(([ns, user]) => ({ ns, user, revision: 1, value: user }),
	);
	const adapters = [];
	const directory = [];
	const discoveries = [];
	const configEdits = [];
	const presentations = [];
	/** Hooks the plugin installed; the stub seam fires them like the real one. */
	let sectionHooks = null;
	const userSection = {
		providerRoute: "opencode-go",
		baseURL: "https://gateway.example.test/v1",
		models
	};
	let editorConfig = structuredClone(userSection);
	let source = () => userSection;
	const replace = async (ns, section, revision) => {
		replaced.push({ ns, section, revision });
		// a real commit is visible to the next read, so mirror that here —
		// otherwise a re-scan after removal would still see the old route
		userSections[ns] = section;
	};
	const legacySettings = {
		register() {},
		describe() { return describeResult; },
		replace,
		get(ns) {
			if (ns === "locale") return { preference: "en" };
			return userSections[ns];
		},
		async update(ns, patch) {
			updates.push({ ns, patch });
			Object.assign(userSection, patch);
			// the real seam emits onChange after every committed change
			sectionHooks?.onChange?.();
		},
		installSection(owner, ns, schema, entry, hooks) {
			sectionHooks = hooks;
			hooks.setSource(source);
			hooks.onChange?.();
		}
	};
	const modernSettings = {
		configure(presentation) {
			presentations.push(presentation);
			return () => {};
		},
		describe() {
			return [{ ns: "locale", value: { preference: "en" }, user: {}, revision: 1 }, ...describeResult];
		},
		replace,
		async update() {
			throw new Error("ordinary Loader Config must use configEditor on modern DSH");
		}
	};
	const entry = { id: namespace, options: { id: namespace } };
	const ctx = {
		effect(run) { return run(); },
		get(service) { return services.get(service); },
		inject(names, run) {
			for (const name of names) run(services.get(name));
		},
		credentials: {
			async resolve() { return credential === null ? undefined : { value: credential }; },
			async set(ref, value) { storedCredentials.push([ref, value]); }
		},
		logger: { warn(...args) { warnings.push(args.join(" ")); }, error(...args) { warnings.push("ERROR " + args.map((a) => (a && a.message) || a).join(" ")); } },
		llm: {
			registerAdapter(routes2, adapter) {
				for (const route of routes2) {
					if (registered.includes(route)) {
						throw Object.assign(new Error(`an adapter for provider "${route}" is already registered`), { code: "DUPLICATE_ADAPTER" });
					}
				}
				// one live record whose `routes` a replace() swaps in place,
				// mirroring the real handle's ownership of the route set
				const record = { routes: [...routes2], adapter };
				registered.push(...routes2);
				const handle = {
					replace(nextRoutes) {
						for (const route of nextRoutes) {
							if (!record.routes.includes(route) && registered.includes(route)) {
								throw Object.assign(new Error(`an adapter for provider "${route}" is already registered`), { code: "DUPLICATE_ADAPTER" });
							}
						}
						for (const route of record.routes) registered.splice(registered.indexOf(route), 1);
						record.routes = [...nextRoutes];
						registered.push(...nextRoutes);
					}
				};
				adapters.push(record);
				return handle;
			},
			registerConfigurableProviders(entries) {
				directory.push(...entries);
				return {
					replace(next) {
						directory.length = 0;
						directory.push(...next);
					}
				};
			},
			registerModelDiscovery(ns, discover) { discoveries.push({ ns, discover }); return () => {}; },
			// the directory the conflict scan walks
			listConfigurableProviders() { return configurable; }
		},
		settings: settingsApi === "modern" ? modernSettings : legacySettings,
		webServer: {
			register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
			tapIndex() { return () => {}; }
		},
		commands: {
			register(command) { commands.set(command.name, command); return () => commands.delete(command.name); }
		}
	};
	if (settingsApi === "modern") ctx.fiber = { entry };
	const configEditor = {
		async edit(target, change) {
			assert.equal(target, entry);
			const next = change(structuredClone(editorConfig), {});
			editorConfig = structuredClone(next);
			configEdits.push(structuredClone(next));
		}
	};
	const services = new Map([
		// the host reaches optional services through ctx.get(name)
		["credentials", ctx.credentials],
		...(settingsApi === "modern" ? [["configEditor", configEditor]] : [])
	]);
	apply(ctx, settingsApi === "modern" ? editorConfig : undefined);
	return {
		routes, commands, updates, adapters, directory, discoveries, replaced, warnings, configEdits, presentations,
		/** Restore `globalThis.fetch`, so a later test never inherits this mock. */
		dispose() { globalThis.fetch = previousFetch; }
	};
}

test("config schema is self-contained and reports invalid fields", () => {
	// DSH 0.1.7's Settings scanner reads these Schemastery-facing properties
	// even for a dependency-free Standard Schema before it decides there is no
	// volatile form to expose.
	assert.deepEqual(Config.meta, {});
	assert.equal(Config.type, "custom");
	const value = Config({});
	assert.equal(value.providerRoute, "opencode-go-plus");
	assert.equal(value.apiKeyEnv, "OPENCODE_GO_API_KEY");
	assert.equal(value.timeoutMs, 15000);
	assert.deepEqual(value.models, []);
	assert.deepEqual(Config["~standard"].validate({ retries: "three" }).issues[0].path, ["retries"]);
	assert.equal(Config({ models: [{ id: "omen-alpha" }] }).models.length, 1);
	assert.throws(() => Config({ models: [{ id: "" }] }), /id must be a non-empty string/);
	assert.throws(() => Config({ providerRoute: "Bad_Route" }), /lowercase hyphenated/);
});










test("the picker label is distinct from the official OpenCode GO route", () => {
	const { adapters, directory } = host();
	// both labels a user sees must not read as the plain official name
	const pickerName = adapters[0]?.adapter.providerInfo("opencode-go-plus").name;
	assert.equal(pickerName, "OpenCode GO Plus");
	assert.notEqual(pickerName, "OpenCode GO");
	// the official Models page is deliberately not used, so the label lives
	// only on the picker
	assert.deepEqual(directory, []);
	// the route itself may keep its own key; only the label must differ
	assert.equal(adapters[0]?.adapter.providerInfo("opencode-go-plus").id, "opencode-go-plus");
});

test("the plugin registers its adapter and command, and stays out of the official directory", () => {
	const { adapters, directory, discoveries, commands } = host();
	assert.deepEqual(adapters[0]?.routes, ["opencode-go"]);
	assert.ok(commands.get("opencode-go-plus-refresh"));
	// Deliberate: DSH's Models page renders only the llm-deepseek / llm-pi-ai
	// layouts and substitutes a fixed "edit settings.yaml" note for any other
	// namespace, so listing this route there would show a dead entry. The chat
	// picker reads the adapter registry instead, so nothing is lost.
	assert.deepEqual(directory, []);
	assert.deepEqual(discoveries, []);
});

test("a configured route owned by another adapter never crashes the plugin", () => {
	// the mock's user section configures "opencode-go", which is already taken
	const { adapters, routes } = host({ registered: ["opencode-go"] });
	// the default route registered before settings attached is kept, so the
	// plugin stays serviceable instead of failing to mount
	assert.deepEqual(adapters[0]?.routes, ["opencode-go-plus"]);
	assert.ok(routes.get("/dsh-opencode-go-plus/models-info")); // surfaces stay up
});

test("info route reads the plugin's own model list", async (t) => {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "deepseek-v4-flash" }] }; }
	}));
	const { routes } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.provider, "opencode-go");
	assert.equal(body.configured, 1);
	assert.deepEqual(body.models, ["deepseek-v4-flash"]);
});

test("refresh route writes the live list into the plugin's namespace", async (t) => {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "deepseek-v4-flash" }, { id: "glm-5.3" }, { id: "union-alpha" }] }; }
	}));
	const { routes, updates } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-refresh").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.total, 3);
	assert.deepEqual(body.added, ["glm-5.3", "union-alpha"]);
	assert.deepEqual(body.removed, []);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].ns, namespace);
	assert.deepEqual(updates[0].patch.models.map((model) => model.id), ["deepseek-v4-flash", "glm-5.3", "union-alpha"]);
});

test("apply route writes exactly the picked ids into the plugin's namespace", async () => {
	const { routes, updates } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-apply").handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ ids: ["deepseek-v4-flash", "union-alpha"] })));
			if (ev === "end") fn();
		}
	}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.deepEqual(body.models, ["deepseek-v4-flash", "union-alpha"]);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].ns, namespace);
	assert.deepEqual(updates[0].patch.models.map((model) => model.id), ["deepseek-v4-flash", "union-alpha"]);
});

test("apply route accepts an empty selection and disables every model", async () => {
	const { routes, updates } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-apply").handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ ids: [] })));
			if (ev === "end") fn();
		}
	}, res);
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.total, 0);
	// `selected` + empty is the state that means "nothing enabled"; under the
	// default `catalog` an empty list would read as "serve everything"
	assert.equal(updates[0].patch.modelSource, "selected");
	assert.deepEqual(updates[0].patch.models, []);
});

test("apply route rejects a malformed ids field", async () => {
	const { routes } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-apply").handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ ids: "omen-alpha" })));
			if (ev === "end") fn();
		}
	}, res);
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.body).error, /ids must be an array/);
});

test("every directly used service is declared in inject", async (t) => {
	// Regression guard: accessing `ctx.settings` (routes, chat command) without
	// declaring it in `inject` fails at runtime with
	// "cannot get property \"settings\" without inject".
	const declared = new Set(inject);
	for (const service of ["llm", "settings", "webServer", "commands"]) {
		assert.ok(declared.has(service), `ctx.${service} is used directly but not declared in inject`);
	}
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "omen-alpha" }] }; }
	}));
	const { routes, commands, updates } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-apply").handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ ids: ["omen-alpha"] })));
			if (ev === "end") fn();
		}
	}, res);
	assert.equal(updates.length, 1); // ctx.settings.update reached via the declared service
	const result = await commands.get("opencode-go-plus-refresh").handler();
	assert.equal(result.kind, "success"); // ctx.settings.get("locale") reached the same way
});

test("the request cap is the route default, not the model capability", async () => {
	// capability is 384000 for this model; a request must NOT ask for that much
	const config = {
		providerRoute: "r", baseURL: "https://example.test/v1", apiKeyEnv: "K", modelSource: "selected",
		retries: 0, timeoutMs: 5000, defaultContextWindow: 262144, defaultMaxTokens: 32768,
		models: [{ id: "deepseek-v4.1-flash" }]
	};
	const live = await fixtureCatalog();
	const adapter = new OpenCodeGoAdapter({
		options: () => config,
		resolveApiKey: async () => "k",
		metadata: () => live
	});
	const realized = await adapter.resolveModel("r", "deepseek-v4.1-flash");
	// the harness materializes `defaultMaxTokens` as the per-request cap
	assert.equal(realized.defaultMaxTokens, 32768);
	// while the model still reports its full output capability
	assert.ok(realized.context?.contextWindow === 1000000);

	// a route that raises its own default raises the request cap, bounded by
	// the model's capability and context window
	const bigger = { ...config, defaultMaxTokens: 999999 };
	const biggerAdapter = new OpenCodeGoAdapter({ options: () => bigger, resolveApiKey: async () => "k", metadata: () => live });
	assert.equal((await biggerAdapter.resolveModel("r", "deepseek-v4.1-flash")).defaultMaxTokens, 384000);
});




test("the three wire protocols are all available to the adapter", () => {
	// the gateway serves models on all three; pi-ai owns the encoding of each
	assert.deepEqual([...SUPPORTED_PROTOCOLS].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

test("the settings schema accepts every protocol the runtime supports", () => {
	// Regression guard: `openai-responses` was missing from the schema's allowed
	// set, so the card could SELECT a responses model but the settings write was
	// refused — the model was unusable through the UI.
	assert.deepEqual([...WIRE_PROTOCOLS].sort(), [...SUPPORTED_PROTOCOLS].sort());
	for (const api of SUPPORTED_PROTOCOLS) {
		const configured = Config({ models: [{ id: "some-model", api }] });
		assert.equal(configured.models[0].api, api);
	}
	assert.throws(() => Config({ models: [{ id: "some-model", api: "not-a-protocol" }] }), /api must be one of/);
});

test("each protocol gets the endpoint shape its SDK expects", () => {
	// the Anthropic SDK appends /v1/messages itself, so it must NOT be given one
	assert.equal(endpointFor("https://x.test/v1", "anthropic-messages"), "https://x.test");
	assert.equal(endpointFor("https://x.test", "anthropic-messages"), "https://x.test");
	// the OpenAI SDKs append only the path, so the version segment must be there
	assert.equal(endpointFor("https://x.test", "openai-completions"), "https://x.test/v1");
	assert.equal(endpointFor("https://x.test", "openai-responses"), "https://x.test/v1");
	assert.equal(endpointFor("https://x.test/v1/", "openai-completions"), "https://x.test/v1");
});

test("a resolved entry becomes a pi-ai model on its own protocol", () => {
	const model = toPiModel({
		id: "union-alpha",
		resolved: {
			name: "Union Alpha Free",
			api: "anthropic-messages",
			reasoning: true,
			efforts: ["low", "high"],
			offWire: null,
			input: ["text", "image"],
			contextWindow: 262144,
			maxTokens: 131072
		},
		baseURL: "https://x.test/v1",
		provider: "opencode-go-plus"
	});
	// pi-ai dispatches on `api`, which is what lets one route serve mixed wires
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.baseUrl, "https://x.test");
	assert.equal(model.contextWindow, 262144);
	assert.equal(model.maxTokens, 131072);
	assert.deepEqual(model.input, ["text", "image"]);
	// pi-ai reads thinking levels off this map; `off` is the model's off wire
	assert.deepEqual(model.thinkingLevelMap, { off: null, low: "low", high: "high" });
});

test("a model without a declared protocol is refused loudly", async () => {
	// resolveEntry deliberately supplies no default wire: guessing one would
	// send union-alpha to chat completions, which answers 500
	assert.equal(resolveEntry("union-alpha", { id: "union-alpha" }, undefined).api, undefined);
	const config = {
		providerRoute: "r", baseURL: "https://x.test/v1", apiKeyEnv: "K", modelSource: "selected",
		retries: 0, timeoutMs: 5000, defaultContextWindow: 262144, defaultMaxTokens: 32768,
		models: [{ id: "union-alpha" }]
	};
	const adapter = new OpenCodeGoAdapter({
		options: () => config,
		resolveApiKey: async () => "k",
		metadata: () => new Map(),
		loadMetadata: async () => new Map() // catalog unavailable
	});
	await assert.rejects(
		adapter.resolveModel("r", "union-alpha"),
		/no known wire protocol/
	);
});

test("a stored entry carries everything an offline deployment needs", async () => {
	// the card materializes the protocol, so a stored entry no longer depends
	// on the live catalog being reachable
	const live = new Map([["grok-4.6", {
		name: "Grok 4.6", contextWindow: 500000, maxTokens: 500000,
		input: ["text", "image"], reasoning: true, efforts: ["low"], api: "openai-responses"
	}]]);
	const fields = catalogEntryFields("grok-4.6", live);
	assert.equal(fields.api, "openai-responses");
	assert.deepEqual(fields.input, ["text", "image"]);
	assert.equal(fields.contextWindow, 500000);

	// resolving that stored entry WITHOUT any catalog still yields its protocol
	const offline = resolveEntry("grok-4.6", fields, new Map());
	assert.equal(offline.api, "openai-responses");
	assert.equal(offline.contextWindow, 500000);
	assert.deepEqual(offline.input, ["text", "image"]);
	assert.equal(offline.reasoning, true);
	assert.deepEqual(offline.efforts, ["low"]);
});

test("user overrides win over catalog facts, field by field", () => {
	const live = new Map([["glm-5.3-flash", {
		name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 131072,
		input: ["text", "image"], reasoning: true, efforts: ["low", "high"], api: "openai-completions"
	}]]);
	const resolved = resolveEntry("glm-5.3-flash", { contextWindow: 4096, input: ["text"] }, live);
	assert.equal(resolved.contextWindow, 4096, "the user's value wins");
	assert.deepEqual(resolved.input, ["text"]);
	assert.equal(resolved.maxTokens, 131072, "untouched fields keep the catalog value");
	assert.equal(resolved.api, "openai-completions");
});

test("the live catalog is the only model source; an empty one lists nothing", () => {
	// no built-in snapshot by design: the catalog plus user config is all there is
	assert.deepEqual(catalogIds(new Map()), []);
	assert.deepEqual(servedEntries([], "catalog", new Map()), []);
	assert.deepEqual(catalogIds(new Map([["a", {}], ["b", {}]])), ["a", "b"]);
	// `selected` serves exactly what is configured, catalog or not
	assert.deepEqual(servedEntries([{ id: "x" }], "selected", new Map()), [{ id: "x" }]);
});

/** The fixture catalog in the Map form `resolveEntry` consumes. */
async function fixtureCatalog() {
	const { extractCatalog } = await import("../lib/modelsdev.js");
	return extractCatalog(MODELS_DEV_FIXTURE);
}

test("models.dev normalization extracts modalities, limits, efforts and off-wire", async () => {
	const { normalizeModel, supportedModalities, effortLevels, extractCatalog } = await import("../lib/modelsdev.js");
	// video/pdf are published but not carried by these wires, so they are dropped
	assert.deepEqual(supportedModalities(["text", "image", "video", "pdf"]), ["text", "image"]);
	assert.deepEqual(supportedModalities(undefined), []);
	assert.deepEqual(effortLevels([{ type: "effort", values: ["low", "high"] }]).efforts, ["low", "high"]);
	// "none" is the catalog's spelling of the off wire, not a selectable level
	assert.deepEqual(effortLevels([{ type: "effort", values: ["none", "low", "high"] }]), { efforts: ["low", "high"], offWire: "none" });

	const normalized = normalizeModel({
		name: "DeepSeek V4.1 Flash",
		reasoning: true,
		modalities: { input: ["text", "image"], output: ["text"] },
		limit: { context: 1000000, output: 384000 },
		reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }]
	});
	assert.deepEqual(normalized, {
		name: "DeepSeek V4.1 Flash",
		contextWindow: 1000000,
		maxTokens: 384000,
		input: ["text", "image"],
		reasoning: true,
		efforts: ["low", "high", "max"]
	});

	// an unrelated provider must not leak into the opencode-go catalog
	const catalog = extractCatalog({
		opencode: { models: { "some-model": { name: "Other" } } },
		"opencode-go": { models: { "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" } } }
	});
	assert.deepEqual([...catalog.keys()], ["deepseek-v4.1-flash"]);
});

test("a configuration migrated from llm-pi-ai keeps its capabilities", async () => {
	const live = await fixtureCatalog();
	// pi-ai writes `input: []` on every entry and reads it as "defer to the
	// catalog"; taking it literally would strip image support on migration.
	assert.deepEqual(resolveEntry("deepseek-v4.1-flash", { input: [] }, live).input, ["text", "image"]);
	assert.deepEqual(resolveEntry("deepseek-v4.1-flash", {}, live).input, ["text", "image"]);
	// an explicit non-empty list still wins
	assert.deepEqual(resolveEntry("deepseek-v4.1-flash", { input: ["text"] }, live).input, ["text"]);

	// the same holds for the fields the entry-fields projection materializes
	const fields = catalogEntryFields("deepseek-v4.1-flash", live);
	assert.deepEqual(fields.input, ["text", "image"]);
	assert.equal(fields.contextWindow, 1000000);
	assert.equal(fields.maxTokens, 384000);
	assert.equal(fields.api, "openai-completions");

	// a pi-ai-shaped entry (name/capacities/input:[]) resolves to the same facts
	const migrated = resolveEntry("glm-5.3-flash", {
		name: "GLM-5.3-Flash (2x usage)",
		contextWindow: 1000000,
		maxTokens: 131072,
		input: [],
		compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} }
	}, live);
	assert.equal(migrated.name, "GLM-5.3-Flash (2x usage)");
	assert.equal(migrated.contextWindow, 1000000);
	assert.deepEqual(migrated.input, ["text", "image"], "image support survives the migration");
	assert.equal(migrated.api, "openai-completions");
});


test("cordis inject guard: apply, every route and the command touch only declared services", async (t) => {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "omen-alpha" }] }; }
	}));
	const routes = new Map();
	const commands = new Map();
	const services = {
		// optional services, reachable only through ctx.get(...) — never as
		// ctx.credentials / ctx.attachments properties
		credentials: { resolve: async () => ({ value: "test-key" }) },
		llm: {
			registerAdapter: () => ({ replace() {} }),
			registerConfigurableProviders: () => ({ replace() {} }),
			registerModelDiscovery: () => () => {},
			listConfigurableProviders: () => []
		},
		settings: {
			installSection(owner, ns, schema, entry, hooks) {
				hooks.setSource(() => ({ providerRoute: "opencode-go-plus", baseURL: "https://example.test/v1", models: [] }));
				hooks.onChange?.();
			},
			get() { return undefined; },
			describe() { return []; },
			async update() {},
			async replace() {}
		},
		webServer: {
			register(route) { routes.set(route.path, route); return () => {}; },
			tapIndex() { return () => {}; }
		},
		commands: {
			register(command) { commands.set(command.name, command); return () => {}; }
		}
	};
	// Access to a service the plugin did not declare in `inject` throws exactly
	// like cordis does; `ctx.get(name)` is the sanctioned optional accessor.
	const ctx = new Proxy({
		effect(run) { return run(); },
		get(name) { return services[name]; },
		inject(_names, run) { run(); },
		logger: { warn() {}, error() {} }
	}, {
		get(target, prop) {
			if (typeof prop !== "string" || prop in target) return Reflect.get(target, prop);
			if (!inject.includes(prop)) throw new Error(`cannot get property "${prop}" without inject`);
			return services[prop];
		}
	});
	apply(ctx);
	const req = (body) => ({
		on(ev, fn) {
			if (ev === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
			if (ev === "end") fn();
		}
	});
	for (const [path, body] of [
		["/dsh-opencode-go-plus/models-info", undefined],
		["/dsh-opencode-go-plus/models-refresh", undefined],
		["/dsh-opencode-go-plus/models-check", undefined],
		["/dsh-opencode-go-plus/models-apply", { ids: ["omen-alpha"] }],
		["/dsh-opencode-go-plus/config", undefined],
		["/dsh-opencode-go-plus/config", { baseURL: "https://example.test/v1" }],
		["/dsh-opencode-go-plus/test", undefined]
	]) {
		const res = response();
		await routes.get(path).handler(req(body), res);
		assert.notEqual(res.statusCode, 500, `${path} failed: ${res.body}`);
	}
	const result = await commands.get("opencode-go-plus-refresh").handler();
	assert.equal(result.kind, "success");
});

test("config route reads and writes baseURL plus the key via credentials", async () => {
	const { routes, updates } = host();
	// GET reports the effective connection facts without leaking the key value
	const getRes = response();
	await routes.get("/dsh-opencode-go-plus/config").handler({ method: "GET" }, getRes);
	const read = JSON.parse(getRes.body);
	assert.equal(read.ok, true);
	assert.equal(read.apiKeyEnv, "OPENCODE_GO_API_KEY");
	assert.equal(read.keyConfigured, true);
	assert.equal(read.modelSource, "catalog");

	// POST writes baseURL through settings and the key through credentials
	const setRes = response();
	await routes.get("/dsh-opencode-go-plus/config").handler({
		method: "POST",
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ baseURL: "  https://relay.example.net/v1  ", apiKey: "  sk-test  " })));
			if (ev === "end") fn();
		}
	}, setRes);
	const saved = JSON.parse(setRes.body);
	assert.equal(saved.ok, true);
	// trimmed, and the response reflects the NEW value (not the initial one)
	assert.equal(saved.baseURL, "https://relay.example.net/v1");
	assert.equal(updates.at(-1).patch.baseURL, "https://relay.example.net/v1");
	// the key lands in the credentials seam, trimmed, never in settings
	assert.deepEqual(storedCredentials, [["OPENCODE_GO_API_KEY", "sk-test"]]);
	assert.equal("apiKey" in updates.at(-1).patch, false);
});

test("DSH 0.1.7 starts without installSection/get and persists ordinary Loader Config", async () => {
	const mounted = host({ settingsApi: "modern" });
	const { routes, updates, configEdits, presentations } = mounted;
	assert.deepEqual(presentations, [{ auto: false }]);
	assert.deepEqual(updates, [], "the modern Settings form writer must not receive ordinary Config fields");

	const configRes = response();
	await routes.get("/dsh-opencode-go-plus/config").handler({
		method: "POST",
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ baseURL: "https://modern.example/v1" })));
			if (ev === "end") fn();
		}
	}, configRes);
	assert.equal(configRes.statusCode, 200);
	assert.equal(JSON.parse(configRes.body).baseURL, "https://modern.example/v1");
	assert.equal(configEdits.at(-1).baseURL, "https://modern.example/v1");

	const modelsRes = response();
	await routes.get("/dsh-opencode-go-plus/models-apply").handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ ids: [] })));
			if (ev === "end") fn();
		}
	}, modelsRes);
	assert.equal(modelsRes.statusCode, 200);
	assert.equal(configEdits.at(-1).baseURL, "https://modern.example/v1", "later edits preserve the current profile config");
	assert.equal(configEdits.at(-1).modelSource, "selected");
	assert.deepEqual(configEdits.at(-1).models, []);
	assert.deepEqual(updates, []);
	mounted.dispose();
});

test("config route refuses a malformed baseURL and a bad key ref", async () => {
	const { routes } = host();
	const bad = async (payload) => {
		const res = response();
		await routes.get("/dsh-opencode-go-plus/config").handler({
			method: "POST",
			on(ev, fn) {
				if (ev === "data") fn(Buffer.from(JSON.stringify(payload)));
				if (ev === "end") fn();
			}
		}, res);
		return { status: res.statusCode, body: JSON.parse(res.body) };
	};
	assert.match((await bad({ baseURL: "ftp://nope" })).body.error, /http/);
	assert.match((await bad({ apiKeyEnv: "9bad ref" })).body.error, /environment-variable style/);
	assert.equal((await bad({ baseURL: "" })).body.ok, false);
});

test("the connection test rejects a bad key instead of trusting the model listing", async (t) => {
	// `/v1/models` answers 200 for ANY key, so a probe that used it would call a
	// bogus credential healthy. The real probe must POST to a completion
	// endpoint and read the auth verdict.
	/** Gateway probe requests only (the mount's models.dev fetch is unrelated). */
	const probes = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (init?.method === "POST") probes.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
		return {
			ok: false,
			status: 401,
			headers: new Map(),
			async text() { return JSON.stringify({ error: { message: "Invalid API key.", type: "AuthError" } }); }
		};
	});
	const rejected = host();
	const rejectedRes = response();
	await rejected.routes.get("/dsh-opencode-go-plus/test").handler({}, rejectedRes);
	assert.equal(rejectedRes.statusCode, 502);
	const rejectedBody = JSON.parse(rejectedRes.body);
	assert.equal(rejectedBody.ok, false);
	assert.match(rejectedBody.error, /Invalid API key/);
	// it must have hit a completion endpoint, never the unauthenticated listing
	assert.ok(probes.length > 0, "expected at least one gateway probe");
	for (const call of probes) {
		assert.doesNotMatch(call.url, /\/models$/);
		// the probe body is refused before generation, so it costs no tokens
		assert.deepEqual(call.body.messages, []);
	}

	// a key the gateway accepts, with the body refused for being invalid
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (init?.method === "POST") probes.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
		return {
			ok: false,
			status: 400,
			headers: new Map(),
			async text() { return JSON.stringify({ error: { type: "invalid_request_error", message: "messages must not be empty" } }); }
		};
	});
	const accepted = host();
	const acceptedRes = response();
	await accepted.routes.get("/dsh-opencode-go-plus/test").handler({}, acceptedRes);
	const acceptedBody = JSON.parse(acceptedRes.body);
	assert.equal(acceptedBody.ok, true, "a 400 that is not an auth failure means the key passed");
	assert.equal(Array.isArray(acceptedBody.checks), true);
});

test("a 403 model block is not reported as a rejected credential", async (t) => {
	// This gateway refuses a policy or region block with 403 (DataPolicyError
	// for opt-in models, RegionError for geo-blocked ones) while the credential
	// itself is fine. Folding that into an auth failure made the card blame the
	// key and hid the real reason behind "invalid API key".
	t.mock.method(globalThis, "fetch", async (url, init) => {
		// leave the mount's background catalog fetch alone
		if (init?.method !== "POST") {
			return { ok: true, status: 200, headers: new Map(), async text() { return "{}"; } };
		}
		return {
			ok: false,
			status: 403,
			headers: new Map(),
			async text() {
				return JSON.stringify({ type: "error", error: { type: "RegionError", message: "This model is not available in your country." } });
			}
		};
	});
	const { routes } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/test").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true, "a 403 is a model block, not a credential failure");
	assert.ok(body.checks.length > 0, "expected at least one probe");
	for (const check of body.checks) {
		assert.equal(check.verdict, "accepted", "the key was read and accepted");
		// flagged so the card can say the model is blocked rather than implying
		// that everything about that protocol works
		assert.equal(check.blocked, true);
		assert.match(check.detail, /not available in your country/);
	}
});

test("the connection test probes the field values, not the saved ones", async (t) => {
	// The Test button must answer "do these values work?" before anything is
	// saved. It used to ignore the request body and probe the stored config, so
	// a freshly pasted URL or key reported the health of the OLD connection and
	// the result looked unrelated to what was on screen.
	const probes = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		// leave the mount's background catalog fetch alone
		if (init?.method !== "POST") {
			return { ok: true, status: 200, headers: new Map(), async text() { return "{}"; } };
		}
		const headers = init?.headers ?? {};
		const raw = headers.authorization ?? headers["x-api-key"];
		probes.push({ url: String(url), auth: String(raw).replace(/^Bearer\s+/i, "") });
		return { ok: false, status: 400, headers: new Map(), async text() { return '{"error":{"type":"invalid_request_error","message":"messages must not be empty"}}'; } };
	});
	const { routes } = host({ credential: "sk-stored" });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/test").handler({
		method: "POST",
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ baseURL: "https://draft.example.net/v1", apiKey: "sk-typed" })));
			if (ev === "end") fn();
		}
	}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.ok(probes.length > 0, "expected at least one probe");
	for (const probe of probes) {
		// the draft URL was probed, never the saved one
		assert.match(probe.url, /draft\.example\.net/);
		assert.doesNotMatch(probe.url, /gateway\.example\.test/);
		assert.equal(probe.auth, "sk-typed", "the typed key must be the one tested");
	}
	// the reported target is what was tested, so a draft test is unambiguous
	assert.equal(body.baseURL, "https://draft.example.net/v1");
	// testing is a read-only operation: it must never persist the draft
	assert.deepEqual(storedCredentials, [], "testing must not save the credential");
});

test("an empty key field reuses the stored credential when testing", async (t) => {
	// Matches the Save rule: blank means "keep what is stored", so testing with
	// the key field untouched must still authenticate.
	const auths = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (init?.method !== "POST") {
			return { ok: true, status: 200, headers: new Map(), async text() { return "{}"; } };
		}
		const headers = init?.headers ?? {};
		const raw = headers.authorization ?? headers["x-api-key"];
		auths.push(String(raw).replace(/^Bearer\s+/i, ""));
		return { ok: false, status: 400, headers: new Map(), async text() { return '{"error":{"type":"invalid_request_error"}}'; } };
	});
	const { routes } = host({ credential: "sk-stored" });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/test").handler({
		method: "POST",
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ baseURL: "https://draft.example.net/v1", apiKey: "" })));
			if (ev === "end") fn();
		}
	}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.ok(auths.length > 0);
	for (const auth of auths) assert.equal(auth, "sk-stored");
	assert.deepEqual(storedCredentials, []);

	// whitespace-only is blank too, and must not be probed as a literal key
	auths.length = 0;
	const wsRes = response();
	await routes.get("/dsh-opencode-go-plus/test").handler({
		method: "POST",
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify({ baseURL: "https://draft.example.net/v1", apiKey: "   " })));
			if (ev === "end") fn();
		}
	}, wsRes);
	assert.equal(JSON.parse(wsRes.body).ok, true);
	assert.ok(auths.length > 0);
	for (const auth of auths) assert.equal(auth, "sk-stored");
});

test("the connection test probes every protocol the configuration uses", async (t) => {
	const seen = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		// ignore the mount's background models.dev fetch
		if (init?.method === "POST") seen.push({ url: String(url), headers: init?.headers ?? {} });
		return { ok: false, status: 400, headers: new Map(), async text() { return '{"error":{"type":"invalid_request_error"}}'; } };
	});
	// union-alpha is the anthropic-wire model; the rest are openai-compatible
	const { routes } = host({ models: [{ id: "glm-5.3-flash" }, { id: "union-alpha" }] });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/test").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.checks.length, 2, "one probe per wire protocol in use");
	const paths = seen.map((call) => call.url.replace(/^https?:\/\/[^/]+/, ""));
	assert.ok(paths.some((path) => path.endsWith("/chat/completions")));
	assert.ok(paths.some((path) => path.endsWith("/messages")));
	// the two paths carry DIFFERENT credentials headers, which is why both matter
	const anthropic = seen.find((call) => call.url.endsWith("/messages"));
	assert.ok(anthropic.headers["x-api-key"] !== undefined);
	assert.equal(anthropic.headers["anthropic-version"], "2023-06-01");
	const openai = seen.find((call) => call.url.endsWith("/chat/completions"));
	assert.match(String(openai.headers.authorization), /^Bearer /);
});

test("models-info reports key status, source and stale enabled models", async (t) => {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "omen-alpha" }] }; }
	}));
	const { routes } = host();
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.keyConfigured, true);
	assert.equal(body.modelSource, "catalog");
	// the configured model deepseek-v4-flash is no longer offered by the gateway
	assert.deepEqual(body.stale, ["deepseek-v4-flash"]);
});

test("models-info flags a model the catalog has dropped", async (t) => {
	// The gateway still advertises `ghost-model`, so it is not stale, but the
	// catalog has stopped describing it — which is what happened to union-alpha
	// before the provider retired it. Free to compute (no request), so the card
	// can say it on every load.
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "ghost-model" }, { id: "glm-5.3-flash" }] }; }
	}));
	const { routes } = host({ models: [{ id: "ghost-model" }, { id: "glm-5.3-flash" }] });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.deepEqual(body.stale, [], "the gateway still lists both");
	assert.deepEqual(body.undocumented, ["ghost-model"], "glm-5.3-flash is documented, ghost-model is not");
});

test("models-info returns the live list as candidates, described and flagged", async (t) => {
	// One payload now carries what used to need two routes. It has to describe a
	// model the same way the old candidate route did, because the card renders
	// this list directly.
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "ghost-model" }, { id: "glm-5.3-flash" }, { id: "omen-alpha" }] }; }
	}));
	const { routes } = host({
		models: [
			// documented: the catalog supplies the facts
			{ id: "glm-5.3-flash", name: "ignored, catalog wins" },
			// undocumented: only the stored entry describes it
			{ id: "ghost-model", api: "anthropic-messages", name: "Ghost", contextWindow: 111111, maxTokens: 2222, input: ["text"], reasoning: true }
		]
	});
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(Array.isArray(body.candidates), true, "candidates must be sent");
	// the gateway's live order, every model, so nothing needs a second request
	assert.deepEqual(body.candidates.map((c) => c.id), ["ghost-model", "glm-5.3-flash", "omen-alpha"]);
	// omen-alpha is live but not enabled
	assert.deepEqual(body.candidates.filter((c) => c.enabled).map((c) => c.id), ["ghost-model", "glm-5.3-flash"]);

	const documented = body.candidates.find((c) => c.id === "glm-5.3-flash");
	assert.equal(documented.name, "GLM-5.3-Flash");
	assert.equal(documented.contextWindow, 1000000);
	assert.deepEqual(documented.input, ["text", "image"]);
	assert.equal(documented.undocumented, undefined);

	const ghost = body.candidates.find((c) => c.id === "ghost-model");
	// the stored fallback, plus the mark, so the card can say it is undocumented
	assert.equal(ghost.api, "anthropic-messages");
	assert.equal(ghost.contextWindow, 111111);
	assert.equal(ghost.name, "Ghost");
	assert.equal(ghost.undocumented, true);
	// neither the catalog nor the stored entry lists effort levels, so there is
	// nothing for the picker to offer beyond the model's default
	assert.equal(ghost.efforts, null);

	// the gateway still advertises ghost-model, so it is not stale
	assert.deepEqual(body.stale, []);
	assert.deepEqual(body.undocumented, ["ghost-model"]);
	// and the card needs the URL the list came from
	assert.match(String(body.via), /\/models$/);
});

test("models-info still lists the served set when the live list is unavailable", async (t) => {
	// Degraded, not broken: the gateway listing failed, so there are no
	// candidates to offer, but what is served is still real and worth showing.
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (init?.method === "POST") {
			return { ok: false, status: 400, headers: new Map(), async text() { return "{}"; } };
		}
		throw new Error("gateway unreachable");
	});
	const { routes } = host({ models: [{ id: "glm-5.3-flash" }] });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true, "the payload still succeeds");
	assert.match(String(body.liveError), /unreachable/);
	// the served set is listed, so the card is not blank
	assert.deepEqual(body.candidates.map((c) => c.id), ["glm-5.3-flash"]);
	assert.equal(body.candidates[0].enabled, true);
	// staleness cannot be judged against a list that never arrived
	assert.equal(body.stale, undefined);
});

test("models-check probes every enabled model and separates retired from blocked", async (t) => {
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (init?.method !== "POST") {
			return { ok: true, status: 200, headers: new Map(), async json() { return { data: [] }; }, async text() { return '{"data":[]}'; } };
		}
		const model = JSON.parse(init.body).model;
		// Each response is what the gateway really answers an empty probe with.
		const byModel = {
			// live: refused during validation, so the model itself answered
			"glm-5.3-flash": { status: 400, body: { error: { type: "invalid_request_error", message: "messages must not be empty" } } },
			// advertised, but the provider has retired it
			"union-alpha": { status: 400, body: { error: { message: "Error from provider (Console Go): Upstream request failed: Model is unavailable." } } },
			// alive but this account may not use it
			"muse-spark-1.3-contributor": { status: 403, body: { type: "error", error: { type: "DataPolicyError", message: "requires explicit opt in: https://x/go" } } }
		};
		const hit = byModel[model] ?? { status: 400, body: { error: { message: "messages must not be empty" } } };
		return { ok: false, status: hit.status, headers: new Map(), async text() { return JSON.stringify(hit.body); } };
	});
	const { routes } = host({
		// the three wire protocols, so a per-protocol check would collapse them
		models: [
			{ id: "glm-5.3-flash", api: "openai-completions" },
			{ id: "union-alpha", api: "anthropic-messages" },
			{ id: "muse-spark-1.3-contributor", api: "openai-responses" }
		]
	});
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-check").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(body.checked, 3, "every enabled model is probed, not one per wire");
	assert.deepEqual(body.unavailable, ["union-alpha"]);
	assert.deepEqual(body.blocked, ["muse-spark-1.3-contributor"]);
	const byId = new Map(body.checks.map((check) => [check.model, check.availability]));
	assert.equal(byId.get("glm-5.3-flash"), "available", "a validation refusal means the model answered");
	assert.equal(byId.get("union-alpha"), "unavailable");
	assert.equal(byId.get("muse-spark-1.3-contributor"), "blocked");
	// a retired model must never be reported as merely blocked, or the card
	// would invite the user to fix a policy that is not the problem
	assert.equal(body.blocked.includes("union-alpha"), false);
});

/**
 * A minimal hook runtime for the hand-written card: synchronous re-render, so
 * a dispatched event's effect on the rendered tree can be asserted directly.
 */
function createCardRuntime() {
	const state = { states: [], cursor: 0, effects: [], mounted: false, tree: null, component: null };
	const render = () => {
		state.cursor = 0;
		state.tree = state.component();
		return state.tree;
	};
	const react = {
		useState: (init) => {
			const index = state.cursor++;
			if (index >= state.states.length) state.states[index] = typeof init === "function" ? init() : init;
			return [state.states[index], (next) => {
				state.states[index] = typeof next === "function" ? next(state.states[index]) : next;
				render();
			}];
		},
		useEffect: (fn) => { if (!state.mounted) state.effects.push(fn); },
		useCallback: (fn) => fn
	};
	const jsx = (type, props) => ({ type, props: props || {} });
	return {
		react,
		jsx,
		/** Render once, then run the mount effects (which kick off the loads). */
		mount(component) {
			state.component = component;
			render();
			state.mounted = true;
			for (const fn of state.effects) fn();
		},
		get tree() { return state.tree; }
	};
}

/** Every node in a rendered tree matching `predicate`, in document order. */
function findAll(tree, predicate) {
	const found = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const entry of node) walk(entry); return; }
		if (predicate(node)) found.push(node);
		for (const value of Object.values(node.props || {})) walk(value);
	};
	walk(tree);
	return found;
}

/** The first button whose label is exactly `label`. */
function buttonByLabel(tree, label) {
	return findAll(tree, (node) => node.type === "button" && node.props.children === label)[0];
}

/** Let queued promise callbacks settle (the loads resolve a microtask later). */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Load the card bundle, mount the component, and drive it to the fetched
 * state with a mocked gateway.
 * @param {{ candidates: Array<Record<string, unknown>>, configured: string[] }} data
 */
/**
 * Resolve the bundle's English dictionary the way the harness would, so tests
 * assert on the strings a user actually sees. Locale falls back to `en` here
 * only because these tests assert English copy.
 */
function makeTranslator(dictionaries) {
	const dict = dictionaries.en;
	return (key, params) => {
		const template = dict[key] ?? key;
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
	};
}

/** A locale-service stub whose `bind()` returns the given translator. */
function localeStub(t) {
	return { register() {}, bind() { return t; } };
}

async function mountCardWithCandidates(data) {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	const context = {
		window: { __ModuleLoader__: { load(value) { registration = value; } } },
		document: {
			querySelector() { return {}; },
			createElement() { return { dataset: {}, textContent: "" }; },
			head: { appendChild() {} }
		},
		// the bundle runs inside its own vm context and needs the mocked fetch
		fetch: (...args) => globalThis.fetch(...args)
	};
	vm.runInNewContext(source, context);
	/** The committed selection; mutating it models a real settings write. */
	let served = new Set(data.configured);
	const payloadFor = (url, init) => {
		if (url.endsWith("/models-info")) {
			// The card gets its whole list from this one payload: the gateway's
			// live candidates with the served ones checked. Candidates come only
			// from the LIVE list, so a model that is enabled but no longer on the
			// gateway stays absent — the situation a stale entry describes.
			const candidates = (data.candidates ?? []).map((c) => ({ ...c, enabled: served.has(c.id) }));
			return {
				ok: true, provider: "opencode-go-plus", configured: served.size,
				models: [...served], modelSource: "selected", fromCatalog: false,
				stale: (data.stale ?? []).filter((id) => served.has(id)),
				candidates,
				via: "https://example.test/v1/models",
				undocumented: data.undocumented ?? [],
				conflicts: data.conflicts ?? []
			};
		}
		if (url.endsWith("/remove-route")) return { ok: true, removed: "opencode-go", remaining: [] };
		if (url.endsWith("/config")) {
			return {
				ok: true, baseURL: "https://example.test/v1",
				apiKeyEnv: "OPENCODE_GO_API_KEY", keyConfigured: true, modelSource: "selected"
			};
		}
		// echo the committed ids so a test can assert exactly what was written,
		// and remember them so the follow-up models-info reflects the commit
		if (url.endsWith("/models-apply")) {
			const ids = init?.body ? (JSON.parse(init.body).ids ?? []) : [];
			served = new Set(ids);
			return { ok: true, total: ids.length, models: ids };
		}
		if (url.endsWith("/test")) {
			return {
				ok: true, baseURL: "https://example.test/v1", apiKeyEnv: "OPENCODE_GO_API_KEY",
				ms: 12, models: 1,
				checks: [{ ok: true, status: 400, api: "openai-completions", model: "glm-5.3-flash", verdict: "accepted", detail: "messages must not be empty" }]
			};
		}
		if (url.endsWith("/models-check")) {
			return {
				ok: true, ms: 30, checked: 2,
				unavailable: data.unavailable ?? [],
				blocked: [],
				checks: []
			};
		}
		return { ok: false, error: `unexpected ${url}` };
	};
	const calls = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
		return { status: 200, ok: true, json: async () => payloadFor(String(url), init) };
	};
	try {
		// the runtime must exist before the factory captures its hooks
		const card = createCardRuntime();
		const plugin = registration.factory((name) => name === "react" ? card.react : { jsx: card.jsx, jsxs: card.jsx });
		let Component = null;
		plugin.apply({
			effect(run) { return run(); },
			locale: localeStub(makeTranslator(plugin.dictionaries)),
			slots: {
				inject(_name, run) { return run(); },
				register(_options, component) { Component = component; return () => {}; }
			}
		});
		card.mount(Component);
		await settle();
		// The mount effect loads the live list, so the card is fully populated
		// without any button press — that is the point of merging the routes.
		card.calls = calls;
		// the removal POST fires after this helper returns, so the caller
		// restores the mock itself via card.restoreFetch() once done asserting
		card.restoreFetch = () => { globalThis.fetch = previousFetch; };
		return card;
	} catch (error) {
		globalThis.fetch = previousFetch;
		throw error;
	}
}

const CANDIDATES = [
	{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", input: ["text", "image"], contextWindow: 1000000, maxTokens: 131072, enabled: true },
	{ id: "omen-alpha", name: "Omen Alpha", input: ["text", "image"], contextWindow: 500000, maxTokens: 128000, enabled: true },
	{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", input: ["text", "image"], contextWindow: 1000000, maxTokens: 384000, enabled: false },
	{ id: "union-alpha", name: "Union Alpha Free", input: ["text", "image"], contextWindow: 262144, maxTokens: 131072, enabled: false }
];
/**
 * The ids of the checked candidate rows CURRENTLY RENDERED — so assert with no
 * search/filter active when the question is about the whole selection.
 */
function checkedIds(tree) {
	const rows = findAll(tree, (node) => node.type === "label" && node.props.className === "ocgp-cand");
	return rows.filter((row) => findAll(row, (n) => n.type === "input" && n.props.checked === true).length > 0)
		.map((row) => row.props["data-model"]);
}
function setSearch(card, text) {
	const box = findAll(card.tree, (node) => node.type === "input" && node.props.type === "search")[0];
	box.props.onChange({ target: { value: text } });
}
function pressScope(card, label) {
	const button = findAll(card.tree, (node) => node.type === "button" && node.props["aria-pressed"] !== undefined
		&& node.props.children === label)[0];
	button.props.onClick();
}

/**
 * A sibling route pointing at the SAME gateway as the host's own route, plus an
 * unrelated one — the pair a conflict scan has to tell apart.
 */
const SIBLING_ROUTES = [
	// configured, and pointing at the same service
	{ provider: "opencode-go", displayName: "opencode-go", settingsNs: "llm-pi-ai", settingsPath: ["providers", "opencode-go"] },
	// configured, but a different service
	{ provider: "xhs", displayName: "xhs", settingsNs: "llm-pi-ai", settingsPath: ["providers", "xhs"] },
	// present in the DIRECTORY only — pi-ai ships it as addable, the user has
	// not added it, so it must never be reported
	{ provider: "anthropic", displayName: "anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "anthropic"] },
	// a variant route for the same service: `llm-pi-ai` lists every CONFIGURED
	// profile in the directory, so a variant appears here as soon as it is added
	{ provider: "opencode-go-anthropic", displayName: "opencode-go-anthropic", settingsNs: "llm-pi-ai", settingsPath: ["providers", "opencode-go-anthropic"] }
];
const SIBLING_SECTIONS = {
	"llm-pi-ai": {
		providers: {
			"opencode-go": { baseURL: "https://gateway.example.test/v1", apiKeyEnv: "OPENCODE_GO_API_KEY", models: [{ id: "a" }, { id: "b" }] },
			xhs: { baseURL: "https://unrelated.example.test/v1", apiKeyEnv: "XHS_API_KEY", models: [{ id: "c" }] }
			// `anthropic` is absent on purpose: it is addable but not added
		}
	}
};

function listingMock(t) {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: true,
		headers: new Map([["content-type", "application/json"]]),
		async json() { return { data: [{ id: "deepseek-v4-flash" }] }; }
	}));
}

function postRoute(routes, path, body) {
	const res = response();
	return routes.get(path).handler({
		on(ev, fn) {
			if (ev === "data") fn(Buffer.from(JSON.stringify(body)));
			if (ev === "end") fn();
		}
	}, res).then(() => res);
}

test("a conflicting route is also reported in the log, not only on the card", async (t) => {
	listingMock(t);
	// the card is the actionable surface, but a user staring at duplicated picker
	// entries may never open it — so the same finding is logged at mount
	const { warnings } = host({ configurable: SIBLING_ROUTES, userSections: SIBLING_SECTIONS });
	const conflictWarning = warnings.find((line) => line.includes("also configured on"));
	assert.ok(conflictWarning, `expected a conflict warning, got: ${JSON.stringify(warnings)}`);
	assert.match(conflictWarning, /"opencode-go"/);
	// and it must not fire for a configuration with no conflict
	const clean = host({ configurable: SIBLING_ROUTES, userSections: { "llm-pi-ai": { providers: { xhs: {} } } } });
	assert.equal(clean.warnings.some((line) => line.includes("also configured on")), false);
});

test("a configured OpenCode GO route elsewhere is reported as a conflict", async (t) => {
	listingMock(t);
	const { routes } = host({ configurable: SIBLING_ROUTES, userSections: SIBLING_SECTIONS });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	// the identity is the provider key, not the URL: `opencode-go` is OpenCode GO
	// whether it points at a relay or at the official domain. `xhs` is a
	// different service, and `anthropic` is only addable — neither is reported.
	assert.equal(body.conflicts.length, 1);
	const conflict = body.conflicts[0];
	assert.equal(conflict.provider, "opencode-go");
	assert.equal(conflict.settingsNs, "llm-pi-ai");
	assert.deepEqual(conflict.settingsPath, ["providers", "opencode-go"]);
	assert.equal(conflict.modelCount, 2);
	assert.equal(conflict.removable, true);
});

test("an empty profile still counts as configured OpenCode GO", async (t) => {
	listingMock(t);
	// `opencode-go: {}` is what the Models page writes for a one-click add: no
	// baseURL, no model list — and it serves the full catalog, so it duplicates
	// every model. A URL comparison used to miss exactly this case.
	const sections = { "llm-pi-ai": { providers: { "opencode-go": {} } } };
	const { routes } = host({ configurable: SIBLING_ROUTES, userSections: sections });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.equal(body.conflicts.length, 1);
	assert.equal(body.conflicts[0].provider, "opencode-go");
	// no model list means catalog-driven, reported as unknown rather than zero
	assert.equal(body.conflicts[0].modelCount, null);
});

test("a route variant for the same service is reported too", async (t) => {
	listingMock(t);
	const sections = { "llm-pi-ai": { providers: { "opencode-go-anthropic": { baseURL: "https://elsewhere.example.test" } } } };
	const { routes } = host({ configurable: SIBLING_ROUTES, userSections: sections });
	const res = response();
	await routes.get("/dsh-opencode-go-plus/models-info").handler({}, res);
	const body = JSON.parse(res.body);
	assert.deepEqual(body.conflicts.map((c) => c.provider), ["opencode-go-anthropic"]);
});

test("removing a conflicting route deletes only that key", async (t) => {
	listingMock(t);
	const { routes, replaced } = host({ configurable: SIBLING_ROUTES, userSections: structuredClone(SIBLING_SECTIONS) });
	const res = await postRoute(routes, "/dsh-opencode-go-plus/remove-route", {
		settingsNs: "llm-pi-ai",
		settingsPath: ["providers", "opencode-go"]
	});
	const body = JSON.parse(res.body);
	assert.equal(body.ok, true);
	assert.equal(replaced.length, 1);
	assert.equal(replaced[0].ns, "llm-pi-ai");
	// the removed route is gone, everything else in that namespace survives
	assert.equal(replaced[0].section.providers["opencode-go"], undefined);
	assert.deepEqual(replaced[0].section.providers.xhs, SIBLING_SECTIONS["llm-pi-ai"].providers.xhs);
	// and the conflict list is now empty
	assert.deepEqual(body.remaining, []);
});

test("removal is refused while the default model still uses that route", async (t) => {
	listingMock(t);
	const sections = structuredClone(SIBLING_SECTIONS);
	sections["agent-default-model"] = { provider: "opencode-go", model: "a" };
	const { routes, replaced } = host({ configurable: SIBLING_ROUTES, userSections: sections });
	const res = await postRoute(routes, "/dsh-opencode-go-plus/remove-route", {
		settingsNs: "llm-pi-ai",
		settingsPath: ["providers", "opencode-go"]
	});
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.body).error, /default model still uses route "opencode-go"/);
	assert.equal(replaced.length, 0, "nothing may be written");
});

test("removal refuses a route that is not a conflict", async (t) => {
	listingMock(t);
	const { routes, replaced } = host({ configurable: SIBLING_ROUTES, userSections: structuredClone(SIBLING_SECTIONS) });
	// `xhs` is a real route but points elsewhere, so it must not be removable here
	const res = await postRoute(routes, "/dsh-opencode-go-plus/remove-route", {
		settingsNs: "llm-pi-ai",
		settingsPath: ["providers", "xhs"]
	});
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.body).error, /not a conflicting OpenCode GO route/);
	assert.equal(replaced.length, 0);

	// nor may the plugin touch its own namespace through this path
	const own = await postRoute(routes, "/dsh-opencode-go-plus/remove-route", {
		settingsNs: namespace,
		settingsPath: ["models"]
	});
	assert.equal(own.statusCode, 400);
	assert.match(JSON.parse(own.body).error, /belongs to the plugin itself/);
});

test("the card surfaces a duplicate route and can remove it", async () => {
	const conflict = {
		provider: "opencode-go", displayName: "opencode-go", settingsNs: "llm-pi-ai",
		settingsPath: ["providers", "opencode-go"], apiKeyEnv: "OPENCODE_GO_API_KEY",
		modelCount: 27, removable: true
	};
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash"],
		conflicts: [conflict]
	});
	// the warning names the offending route and offers the fix
	const warning = findAll(card.tree, (n) => typeof n.props?.className === "string" && n.props.className === "ocgp-line ocgp-warn");
	assert.ok(warning.some((node) => String(node.props.children).includes("listed twice")));
	const button = buttonByLabel(card.tree, "Delete opencode-go");
	assert.ok(button, "expected a removal button");

	button.props.onClick();
	await settle();
	const removal = card.calls.find((call) => call.url.endsWith("/remove-route"));
	assert.ok(removal, "expected a POST to the removal route");
	assert.equal(removal.method, "POST");
	assert.deepEqual(JSON.parse(removal.body), {
		settingsNs: "llm-pi-ai",
		settingsPath: ["providers", "opencode-go"]
	});
});

test("bulk selection acts on the visible subset, not the whole list", async () => {
	const card = await mountCardWithCandidates({ candidates: CANDIDATES, configured: ["glm-5.3-flash", "omen-alpha"] });
	assert.deepEqual(checkedIds(card.tree).sort(), ["glm-5.3-flash", "omen-alpha"]);

	// filter down to one row, then "全选显示项" must add ONLY that row
	setSearch(card, "deepseek");
	assert.equal(findAll(card.tree, (n) => n.type === "label" && n.props.className === "ocgp-cand").length, 1);
	buttonByLabel(card.tree, "Select shown").props.onClick();
	setSearch(card, ""); // back to the full list to inspect the whole selection
	assert.deepEqual(checkedIds(card.tree).sort(), ["deepseek-v4.1-flash", "glm-5.3-flash", "omen-alpha"]);

	// "反选" flips only the filtered rows
	setSearch(card, "deepseek");
	buttonByLabel(card.tree, "Invert").props.onClick();
	setSearch(card, "");
	assert.deepEqual(checkedIds(card.tree).sort(), ["glm-5.3-flash", "omen-alpha"]);
});

test("scope filter and bulk actions cover enabled/disabled views", async () => {
	const card = await mountCardWithCandidates({ candidates: CANDIDATES, configured: ["glm-5.3-flash", "omen-alpha"] });
	// "未启用" shows exactly the two the gateway is not serving
	pressScope(card, "Disabled");
	assert.equal(findAll(card.tree, (n) => n.type === "label" && n.props.className === "ocgp-cand").length, 2);
	buttonByLabel(card.tree, "Select shown").props.onClick();
	pressScope(card, "All");
	assert.deepEqual(checkedIds(card.tree).sort(), ["deepseek-v4.1-flash", "glm-5.3-flash", "omen-alpha", "union-alpha"]);
	// "已启用" scoped clear removes only those two
	pressScope(card, "Enabled");
	buttonByLabel(card.tree, "Clear shown").props.onClick();
	pressScope(card, "All");
	assert.deepEqual(checkedIds(card.tree).sort(), ["deepseek-v4.1-flash", "union-alpha"]);
});

test("unsaved changes are surfaced and can be discarded", async () => {
	const card = await mountCardWithCandidates({ candidates: CANDIDATES, configured: ["glm-5.3-flash", "omen-alpha"] });
	// nothing changed yet: no commit prompt, no discard affordance
	assert.equal(buttonByLabel(card.tree, "Discard changes"), undefined);
	assert.equal(buttonByLabel(card.tree, "Enable selected (2)").props.disabled, true);

	// toggle one row -> dirty
	const boxes = findAll(card.tree, (node) => node.type === "input" && node.props.type === "checkbox");
	boxes[0].props.onChange();
	assert.equal(buttonByLabel(card.tree, "Discard changes") !== undefined, true);
	assert.equal(buttonByLabel(card.tree, "Enable selected (1)").props.disabled, false);

	// discarding restores the fetched baseline
	buttonByLabel(card.tree, "Discard changes").props.onClick();
	assert.deepEqual(checkedIds(card.tree).sort(), ["glm-5.3-flash", "omen-alpha"]);
	assert.equal(buttonByLabel(card.tree, "Discard changes"), undefined);
});

test("the counter tracks selection against the full list", async () => {
	const card = await mountCardWithCandidates({ candidates: CANDIDATES, configured: ["glm-5.3-flash", "omen-alpha"] });
	const counter = () => findAll(card.tree, (n) => typeof n.props?.className === "string" && n.props.className === "ocgp-count")[0].props.children;
	assert.equal(counter(), "2 / 4 selected");
	setSearch(card, "alpha");
	// "alpha" matches omen-alpha (already on) and union-alpha (off)
	assert.match(counter(), /2 \/ 4 selected · 2 shown/);
	buttonByLabel(card.tree, "Select shown").props.onClick();
	assert.match(counter(), /3 \/ 4 selected · 2 shown/);
});

test("the card renders with the connection and model controls", async () => {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	const context = {
		window: { __ModuleLoader__: { load(value) { registration = value; } } },
		document: {
			querySelector() { return {}; },
			createElement() { return { dataset: {}, textContent: "" }; },
			head: { appendChild() {} }
		}
	};
	vm.runInNewContext(source, context);
	// faithful hooks: useState must return its initial value, or the component
	// would be exercised against `undefined` state that React never produces
	const reactStub = {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn
	};
	const jsx = (type, props) => ({ type, props: props || {} });
	const plugin = registration.factory((name) => name === "react" ? reactStub : { jsx, jsxs: jsx });
	let mounted = null;
	plugin.apply({
		effect(run) { return run(); },
		locale: localeStub(makeTranslator(plugin.dictionaries)),
		slots: {
			inject(_name, run) { return run(); },
			register(options, component) { mounted = { options, component }; return () => {}; }
		}
	});
	const tree = mounted.component(); // throws if the component body is broken
	const inputs = [];
	const buttons = [];
	const walk = (node) => {
		if (node === null || node === undefined || typeof node !== "object") return;
		if (Array.isArray(node)) { for (const entry of node) walk(entry); return; }
		if (node.type === "input") inputs.push(node.props["aria-label"]);
		if (node.type === "button" && typeof node.props.children === "string") buttons.push(node.props.children);
		for (const value of Object.values(node.props || {})) walk(value);
	};
	walk(tree);
	assert.deepEqual(inputs, ["Gateway URL", "API key"]);
	// the apply button only appears once candidates are fetched
	assert.deepEqual(buttons, ["Save", "Test connection", "Refresh list", "Check model availability"]);
	// and the line that answers "must I save before testing?"
	const hints = findAll(tree, (node) => typeof node.props?.children === "string"
		&& node.props.children.includes("saving first is not required"));
	assert.equal(hints.length, 1, "the Save/Test hint must be rendered");
});

test("the card warns about an enabled model the catalog dropped", async () => {
	// The free, request-less half of the retired-model story: union-alpha sat in
	// the gateway listing long after the catalog stopped documenting it, and
	// saying so costs nothing on every card load.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "union-alpha"],
		undocumented: ["union-alpha"]
	});
	try {
		const warn = findAll(card.tree, (node) => typeof node.props?.children === "string"
			&& node.props.children.includes("possibly retired"));
		assert.equal(warn.length, 1, "the undocumented warning must render");
		assert.match(warn[0].props.children, /union-alpha/);
	} finally {
		card.restoreFetch();
	}
});

test("the card opens with the whole live list already loaded", async () => {
	// Opening the card used to say "N models enabled" and show nothing until the
	// user pressed a button — and that button cost a SECOND request for a list
	// the card had already fetched to compute staleness. The mount load now
	// brings the candidates, so the list is there, editable, straight away.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "union-alpha"],
		undocumented: ["union-alpha"]
	});
	try {
		// exactly one list request, on mount
		const listCalls = card.calls.filter((call) => call.url.endsWith("/models-info"));
		assert.equal(listCalls.length, 1, "one payload carries the list");

		// every live model is listed, not just the enabled ones
		const rows = findAll(card.tree, (node) => node.type === "label" && node.props.className === "ocgp-cand");
		assert.equal(rows.length, CANDIDATES.length, "the full live list is shown");
		const listed = rows.map((row) => row.props["data-model"]);
		for (const c of CANDIDATES) {
			assert.ok(listed.includes(c.id), `${c.id} must be listed`);
		}

		// and it is editable immediately: the served two are checked
		const boxes = findAll(card.tree, (node) => node.type === "input" && node.props.type === "checkbox");
		assert.equal(boxes.filter((b) => b.props.checked).length, 2, "only the served models are checked");
		assert.ok(buttonByLabel(card.tree, "Enable selected (2)"), "the commit control is present from the start");
		assert.ok(buttonByLabel(card.tree, "Refresh list"), "reloading is still available");

		// a model whose gateway name says more than its id gets both
		const descs = findAll(card.tree, (node) => node.props?.className === "ocgp-cand-desc");
		assert.ok(descs.length > 0, "rows carry their facts");
	} finally {
		card.restoreFetch();
	}
});

test("the card shows a model's id only when the name does not already say it", async () => {
	// `glm-5.3-flash` / `GLM-5.3-Flash` is the same string twice; printing both
	// spent a line per row on nothing. `union-alpha` / `Union Alpha Free` is not.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "union-alpha"]
	});
	try {
		const keys = findAll(card.tree, (node) => node.props?.className === "ocgp-cand-key")
			.map((node) => String(node.props.children));
		assert.ok(keys.includes("union-alpha"), "a differing id is shown");
		assert.equal(keys.includes("glm-5.3-flash"), false, "a restyled name must not repeat the id");
		assert.equal(keys.includes("omen-alpha"), false, "nor Omen Alpha");
	} finally {
		card.restoreFetch();
	}
});

test("the card removes a retired model and writes exactly the reduced set", async () => {
	// The reported bug: removal edited `picked`, which could be empty, so it
	// deleted nothing while claiming success and pointing at a button that was
	// not rendered. It must commit the served set minus the retired ids.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "union-alpha"],
		unavailable: ["union-alpha"]
	});
	try {
		buttonByLabel(card.tree, "Check model availability").props.onClick();
		await settle();
		const named = findAll(card.tree, (node) => [].concat(node.props?.children ?? [])
			.filter((child) => typeof child === "string").join(" ").includes("no longer serves them"));
		assert.equal(named.length, 1, "the retired model must be named");

		card.calls.length = 0;
		buttonByLabel(card.tree, "Remove these models and save").props.onClick();
		await settle();

		const applyCall = card.calls.find((call) => call.url.endsWith("/models-apply"));
		assert.ok(applyCall, "removal must commit to the apply endpoint");
		assert.deepEqual(JSON.parse(applyCall.body).ids, ["glm-5.3-flash"]);

		const said = findAll(card.tree, (node) => [].concat(node.props?.children ?? [])
			.filter((child) => typeof child === "string").join(" "))
			.map((node) => [].concat(node.props.children).filter((c) => typeof c === "string").join(" ")).join(" | ");
		assert.match(said, /Removed and saved: union-alpha/);
		// the commit control is present whenever the list is, which is precisely
		// why removal no longer has to hand the user off to it
		assert.ok(buttonByLabel(card.tree, "Enable selected (1)"), "the list stays editable");
	} finally {
		card.restoreFetch();
	}
});

test("the card removes a model that is served but absent from the live list", async () => {
	// A genuinely stale model: enabled in settings, gone from the gateway, so it
	// can never appear among the candidates. Taking the commit set from the
	// served ids rather than the visible rows is what makes this reachable.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "retired-model"],
		stale: ["retired-model"],
		unavailable: ["retired-model"]
	});
	try {
		// it is not among the candidates, so it cannot be unticked
		const rows = findAll(card.tree, (node) => node.type === "label" && node.props.className === "ocgp-cand");
		assert.equal(rows.some((n) => JSON.stringify(n.props.children ?? "").includes("retired-model")), false);

		buttonByLabel(card.tree, "Check model availability").props.onClick();
		await settle();
		card.calls.length = 0;
		buttonByLabel(card.tree, "Remove these models and save").props.onClick();
		await settle();

		const applyCall = card.calls.find((call) => call.url.endsWith("/models-apply"));
		assert.ok(applyCall, "the stale model must still be removable");
		assert.deepEqual(JSON.parse(applyCall.body).ids, ["glm-5.3-flash"]);
	} finally {
		card.restoreFetch();
	}
});

test("the card refuses to remove while the selection has unapplied edits", async () => {
	// With the candidate list loaded the checkboxes may hold unsaved edits, and
	// committing would discard them silently — so that case must ask first.
	const card = await mountCardWithCandidates({
		candidates: CANDIDATES,
		configured: ["glm-5.3-flash", "union-alpha"],
		unavailable: ["union-alpha"]
	});
	try {
		buttonByLabel(card.tree, "Check model availability").props.onClick();
		await settle();

		// make an unrelated edit so the draft differs from the committed set
		const boxes = findAll(card.tree, (node) => node.type === "input" && node.props.type === "checkbox");
		const omen = boxes.find((box) => String(box.props.id).includes("ocgp-cand-"));
		assert.ok(omen);
		// toggle an unrelated row so the draft no longer matches the commit
		const label = findAll(card.tree, (node) => node.type === "label" && node.props["data-model"] === "omen-alpha")[0];
		assert.ok(label, "expected the omen-alpha row");
		const box = findAll(label, (node) => node.type === "input" && node.props.type === "checkbox")[0];
		box.props.onChange();
		await settle();

		card.calls.length = 0;
		buttonByLabel(card.tree, "Remove these models and save").props.onClick();
		await settle();

		assert.equal(card.calls.some((call) => call.url.endsWith("/models-apply")), false,
			"nothing may be written while the draft has unapplied edits");
		const warned = findAll(card.tree, (node) => [].concat(node.props?.children ?? [])
			.filter((child) => typeof child === "string").join(" ").includes("unapplied changes"));
		assert.equal(warned.length, 1, "the user must be told to commit or discard first");
	} finally {
		card.restoreFetch();
	}
});

test("the card's Test connection sends the typed values and says they are unsaved", async () => {
	const card = await mountCardWithCandidates({ candidates: CANDIDATES, configured: ["glm-5.3-flash", "omen-alpha"] });
	try {
		const inputs = findAll(card.tree, (node) => node.type === "input");
		const urlInput = inputs.find((node) => node.props["aria-label"] === "Gateway URL");
		const keyInput = inputs.find((node) => node.props["aria-label"] === "API key");
		assert.ok(urlInput && keyInput, "both connection fields must be present");
		// type a new gateway and a new key, as a user would before saving
		urlInput.props.onChange({ target: { value: "https://draft.example.net/v1" } });
		keyInput.props.onChange({ target: { value: "sk-typed" } });
		await settle();

		card.calls.length = 0;
		buttonByLabel(card.tree, "Test connection").props.onClick();
		await settle();

		const testCall = card.calls.find((call) => call.url.endsWith("/test"));
		assert.ok(testCall, "Test connection must POST to the test route");
		assert.equal(testCall.method, "POST");
		// the values on screen are the ones tested — the whole point of the fix
		assert.deepEqual(JSON.parse(testCall.body), {
			baseURL: "https://draft.example.net/v1",
			apiKey: "sk-typed"
		});

		// and the result says so, so a pass on unsaved values is not mistaken
		// for a saved configuration
		const lines = findAll(card.tree, (node) => typeof node.props?.children === "string"
			&& node.props.children.includes("tested the field values"));
		assert.equal(lines.length, 1, "the unsaved marker must be shown");
	} finally {
		card.restoreFetch();
	}
});

test("client bundles register legacy and current DSH plugin configuration cards", async () => {
	const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	let registration;
	const context = {
		window: { __ModuleLoader__: { load(value) { registration = value; } } },
		document: { querySelector() { return {}; } }
	};
	vm.runInNewContext(source, context);
	assert.ok(registration);
	const plugin = registration.factory(() => ({}));
	const injected = [];
	const registrations = [];
	const namespaces = [];
	plugin.apply({
		effect(run) { return run(); },
		locale: { register(ns) { namespaces.push(ns); }, bind() { return (key) => key; } },
		slots: {
			inject(name, run) { injected.push(name); return run(); },
			register(options, component) { registrations.push({ options, component }); return () => {}; }
		}
	});
	assert.deepEqual(injected, ["settings.plugin.item", "plugins.bundle.config"]);
	assert.deepEqual(registrations.map(({ options }) => ({
		name: options.name,
		key: options.key,
		locale: options.locale
	})), [
		{ name: "settings.plugin.item", key: "dsh-opencode-go-plus", locale: undefined },
		{ name: "plugins.bundle.config", key: "dsh-opencode-go-plus", locale: "dsh-opencode-go-plus" }
	]);
});
