// @ts-check
/**
 * Model facts: OpenCode's published catalog, plus whatever the user overrides.
 *
 * There is deliberately NO built-in model table. A hand-maintained snapshot of
 * the gateway's models goes stale silently — the previous one mislabelled eight
 * models' image support and predated several models the gateway now serves —
 * and it duplicates a source that publishes itself. Instead:
 *
 *   1. the live `models.dev` catalog (see `modelsdev.js`) is authoritative for
 *      name, capacities, modalities, thinking levels and wire protocol;
 *   2. a configured entry overrides it field by field;
 *   3. what the card writes back to settings is a COMPLETE entry, so a
 *      deployment that is offline still serves exactly what it enabled.
 *
 * Nothing here is hand-maintained: the wire protocol arrives as each model's
 * AI SDK package (`provider.npm`), which `modelsdev.js` maps.
 *
 * @module dsh-opencode-go-plus/catalog
 */

/**
 * The UI language for capability tags. DSH stores its own preference in the
 * `locale` settings namespace; an unknown or absent value falls back to `zh`,
 * matching the rest of the harness.
 * @param {unknown} preference
 * @returns {"zh"|"en"}
 */
export function normalizeLocale(preference) {
	return preference === "en" ? "en" : "zh";
}

/**
 * Capability tag labels per language. The tags describe the MODEL, so they are
 * rendered in the active UI language rather than stored — a stored tag would go
 * stale the moment the user switches language.
 */
const CAPABILITY_TAGS = Object.freeze({
	zh: { reasoning: "推理", image: "图文" },
	en: { reasoning: "Reasoning", image: "Image" }
});

/**
 * The capability tags for one model, in the active language.
 * @param {{ reasoning?: boolean, input?: readonly string[] } | undefined} cap
 * @param {"zh"|"en"} [locale]
 * @returns {string[]}
 */
export function capabilityTags(cap, locale = "zh") {
	const labels = CAPABILITY_TAGS[locale] ?? CAPABILITY_TAGS.zh;
	const tags = [];
	if (cap?.reasoning === true) tags.push(labels.reasoning);
	if (Array.isArray(cap?.input) && cap.input.includes("image")) tags.push(labels.image);
	return tags;
}

/**
 * The user-facing display name for one entry: the vendor name plus the
 * capability tags, in the active language. This is what the model picker
 * renders — image support in particular has no other indicator there, since
 * the picker reads `reasoning`/`efforts` but not `inputModalities`.
 * @param {{ name?: string, reasoning?: boolean, input?: readonly string[] } | undefined} cap
 * @param {"zh"|"en"} [locale]
 * @returns {string|undefined}
 */
export function displayName(cap, locale = "zh") {
	if (cap?.name === undefined) return undefined;
	const tags = capabilityTags(cap, locale);
	return tags.length > 0 ? `${cap.name} · ${tags.join(" · ")}` : cap.name;
}

/**
 * A configured modalities list, or `undefined` when it declares nothing.
 *
 * An EMPTY array means "states no answer" in this vocabulary, not "accepts no
 * input": a configuration migrated from an `llm-pi-ai` route carries
 * `input: []` on every entry, and pi-ai reads that as "defer to the catalog"
 * (`declaredInput` returns undefined for it). Reading it literally here would
 * silently strip image support from every migrated model, so an empty list
 * falls through to the catalog exactly as an absent one does.
 * @param {unknown} value
 * @returns {readonly string[]|undefined}
 */
function declaredInput(value) {
	return Array.isArray(value) && value.length > 0 ? value : undefined;
}

/**
 * The live catalog entry for one id, or an empty object when the catalog does
 * not describe it (an unlisted model is still callable by id).
 * @param {string} id
 * @param {Map<string, import("./modelsdev.js").ExternalEntry>} [live]
 * @returns {import("./modelsdev.js").ExternalEntry}
 */
function entryOf(id, live) {
	return live?.get(id) ?? {};
}

/**
 * Merge one configured entry over the live catalog facts. Precedence: the
 * user's explicit entry wins field by field, then the catalog, then the
 * documented defaults.
 * @param {string} id
 * @param {Record<string, unknown> & { id?: string }} [entry] - user config entry.
 * @param {Map<string, import("./modelsdev.js").ExternalEntry>} [live] - live catalog, when loaded.
 * @param {"zh"|"en"} [locale] - language for the capability tags.
 * @returns {{ name: string|undefined, contextWindow: number|undefined, maxTokens: number|undefined, input: readonly string[]|undefined, reasoning: boolean|undefined, efforts: readonly string[]|undefined, offWire: string|null, api: string|undefined }}
 */
export function resolveEntry(id, entry, live, locale = "zh") {
	const cap = entryOf(id, live);
	const efforts = entry?.efforts ?? cap.efforts;
	// The stored name is the plain catalog name (settings stay locale-neutral).
	// Tags are added here, in the active language, so switching language updates
	// the picker without rewriting settings. A name the user customized is
	// shown verbatim — only a name that is still the catalog's gets tags.
	const base = entry?.name ?? cap.name;
	const isCatalogName = cap.name !== undefined && base === cap.name;
	return {
		name: base === undefined ? undefined : isCatalogName ? displayName(cap, locale) : base,
		contextWindow: /** @type {any} */ (entry?.contextWindow) ?? cap.contextWindow,
		maxTokens: /** @type {any} */ (entry?.maxTokens) ?? cap.maxTokens,
		input: declaredInput(entry?.input) ?? cap.input,
		reasoning: /** @type {any} */ (entry?.reasoning) ?? cap.reasoning,
		efforts: Array.isArray(efforts) ? efforts : undefined,
		offWire: /** @type {any} */ (entry?.offWire) ?? cap.offWire ?? null,
		// no protocol default here: `pi-wire` refuses an unknown protocol loudly
		// rather than guessing a wire and failing obscurely at the gateway
		api: /** @type {any} */ (entry?.api) ?? cap.api
	};
}

/**
 * The settings-entry fields for one model: the plain display name, the
 * capacities the catalog knows, and the WIRE PROTOCOL.
 *
 * The name is deliberately WITHOUT capability tags: settings are persisted and
 * shared, so a localized tag baked in here would go stale the moment the UI
 * language changed. `resolveEntry` adds them at render time instead.
 *
 * `api` matters most: it is the field that makes a stored entry
 * self-sufficient. An entry without it would fall back to a default wire and
 * silently break models like `union-alpha` (anthropic) or `grok-4.6`
 * (responses) whenever the live catalog is unavailable.
 * @param {string} id
 * @param {Map<string, import("./modelsdev.js").ExternalEntry>} [live]
 * @returns {Record<string, unknown> & { id: string }}
 */
export function catalogEntryFields(id, live) {
	const cap = entryOf(id, live);
	const name = cap.name;
	return {
		id,
		...(name !== undefined ? { name } : {}),
		...(cap.contextWindow !== undefined ? { contextWindow: cap.contextWindow } : {}),
		...(cap.maxTokens !== undefined ? { maxTokens: cap.maxTokens } : {}),
		...(Array.isArray(cap.input) && cap.input.length > 0 ? { input: [...cap.input] } : {}),
		...(cap.reasoning !== undefined ? { reasoning: cap.reasoning } : {}),
		...(Array.isArray(cap.efforts) && cap.efforts.length > 0 ? { efforts: [...cap.efforts] } : {}),
		...(cap.offWire !== undefined ? { offWire: cap.offWire } : {}),
		...(cap.api !== undefined ? { api: cap.api } : {})
	};
}

/**
 * The model entries a route actually serves.
 *
 * `modelSource` disambiguates an empty list, which would otherwise be
 * overloaded: under `catalog` it means "I have not chosen, serve everything the
 * catalog lists", while under `selected` it means "I chose nothing" — the state
 * a user reaches by unchecking every model and applying. Without the
 * distinction, disabling the last model would silently re-enable everything.
 * @param {ReadonlyArray<Record<string, unknown> & { id: string }>} configured
 * @param {string} [modelSource] - "catalog" (default) or "selected".
 * @param {Map<string, import("./modelsdev.js").ExternalEntry>} [live] - live catalog.
 * @returns {Array<Record<string, unknown> & { id: string }>}
 */
export function servedEntries(configured, modelSource, live) {
	if (modelSource === "selected") return [...configured];
	if (configured.length > 0) return [...configured];
	return catalogIds(live).map((id) => ({ id }));
}

/**
 * Every model id the live catalog lists, in catalog order. Empty when the
 * catalog has not loaded — there is no offline model list by design, only the
 * entries the user has configured.
 * @param {Map<string, import("./modelsdev.js").ExternalEntry>} [live]
 * @returns {string[]}
 */
export function catalogIds(live) {
	return live === undefined ? [] : [...live.keys()];
}
