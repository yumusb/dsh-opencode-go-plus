# dsh-opencode-go-plus

English | [中文](README.zh.md)

An OpenCode GO provider for DSH whose **model list and capabilities are read live** instead of from a snapshot shipped inside the DSH package — which is what lets one route serve every model the gateway offers, across all of its wire protocols.

It registers its own route, so it can run alongside an existing OpenCode GO route while you compare them — see [Migrating](#migrating-from-a-built-in-llm-pi-ai-route).

Compatible with DSH `0.1.6-alpha.1`.

## Why not just use the built-in route?

DSH ships a multi-provider LLM adapter, **`llm-pi-ai`** (package `@deepseek-ai/dsh-llm-pi-ai`), mounted **dormant**: it registers zero routes until a `llm-pi-ai.providers.<route>` entry appears in your settings. So a fresh DSH install has no OpenCode GO route at all.

What it does have is a one-click way to create one. pi-ai ships a model catalog, and DSH's **Settings → Models** offers every catalog provider as addable — `opencode-go` among them. Adding it writes a `llm-pi-ai.providers.opencode-go` block, and the route starts.

If that route is what you have been using, it has two structural problems with this gateway — and the first causes the second.

### 1. The model list is frozen inside the DSH package

`llm-pi-ai` answers "fetch available models" from pi-ai's **installed catalog** — a JSON file shipped inside the npm package. For `opencode-go` that catalog exists, so the button does not even make a network request: it returns the snapshot.

Whatever the gateway adds, renames or retires between DSH releases stays invisible until a new DSH build ships. There is nothing to refresh, because nothing is ever fetched.

This plugin reads OpenCode's published catalog (`models.dev`, the same source OpenCode itself uses) at runtime — on mount and on every fetch — so the list reflects the gateway today. Your settings keep a complete copy of what you enabled, so it also works offline.

### 2. Therefore the protocol has to be pinned per route

The gateway serves models on different wire protocols behind one base URL, and sending a model the wrong one fails outright — `union-alpha` returns **HTTP 500** on chat completions, `grok-4.6` returns **`not supported for format oa-compat`**.

Normally the protocol would come from the catalog. But a stale catalog cannot describe a model it has never heard of, so such a model has no protocol — and `llm-pi-ai` can only be told one at the **route** level, which then overrides the catalog for *every* model on that route.

That is why models on different protocols cannot share an `llm-pi-ai` route: you need one route per protocol and a mental map of which model belongs where. Resolving the protocol **per model** is only possible because the metadata is live, which is why these are one fix and not two.

## What you get

- **Live models and capabilities**, refreshed on demand rather than at DSH release time.
- **One route for every protocol** — no second route, no per-model bookkeeping.
- **No DSH files patched.** The gateway rejects requests without `x-opencode-session` (HTTP 400); the adapter sends the real session id itself, so there is no `fetch` wrapper to install and nothing for an upgrade to overwrite.
- **One card for everything** — gateway URL, API key, a connection test that actually validates the key, and the enabled-model list with search, filters, select-all/invert and a visible unsaved-changes state.
- **Duplicate-route detection.** If another configured route resolves to the same gateway — typically `opencode-go` added through the built-in adapter — every shared model appears twice in the picker. The card detects that by endpoint and removes the redundant route in one click.
- **Bilingual** — the card and the capability labels in the picker follow the harness language.

## How it works

```text
settings: dsh-opencode-go-plus          the plugin's own namespace
  ├── providerRoute / baseURL / apiKeyEnv / modelSource
  ├── retries / timeoutMs / defaultContextWindow / defaultMaxTokens
  └── models: [{ id, name?, contextWindow?, maxTokens?, input?, reasoning?, efforts?, api? }]

credentials: the apiKeyEnv reference (written by the card, never exposed to the browser)

ctx.llm.registerAdapter([providerRoute], OpenCodeGoAdapter)
```

The plugin registers only an adapter. It deliberately stays out of DSH's configurable-provider directory — see [Troubleshooting](#troubleshooting).

### Protocol encoding

The protocols themselves are encoded by [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (MIT), the same library DSH's own `llm-pi-ai` adapter uses — this plugin implements none of them. `lib/pi-wire.js` does three things: pick the protocol per model, convert a DSH conversation into pi-ai's `Context`, and map pi-ai's event stream back to DSH `StreamChunk`s. That mapping is protocol-independent, so it is written once rather than three times.

### Model metadata

The gateway's `GET /v1/models` returns only `id` / `object` / `created` / `owned_by` — no capabilities, and `/v1/models/{id}` is a 404. Model facts therefore come from OpenCode's published catalog (`https://models.dev/api.json`, the `opencode-go` provider), which includes each model's protocol as its AI SDK package name. Precedence, highest first:

1. an explicit entry in your settings,
2. the live published catalog,
3. nothing — an entry whose protocol is unknown is refused, not guessed.

There is no built-in model table. The card writes **complete** entries back to settings (including the protocol), so an enabled model keeps working when the catalog is unreachable.

## Requirements

- DSH installed, `web` profile booted at least once
- Node.js ≥ 18
- An OpenCode GO subscription and its API key

## Install

```bash
# from the package once published
dsh plugin --profile web add dsh-opencode-go-plus

# or from a checkout
dsh plugin --profile web add "$PWD"
```

Then restart `dsh web` and hard-refresh the browser page.

## Usage

Open **Settings → Plugins → Plugin configuration → "OpenCode GO Plus"**:

| control | what it does |
|---|---|
| Gateway URL + API key | Saved directly. The URL goes to settings, the key to the credentials store. |
| Test connection | Probes **the values currently in the fields**, saved or not, so a key can be checked before it is stored. One authenticated request per protocol in use; reports whether the key is actually accepted. The result says when it tested unsaved values. |
| Fetch available models | Lists the gateway's live models as candidates; already-enabled ones are pre-checked. |
| Check model availability | Probes **every enabled model** with one request each (any real model has to answer) and reports the ones the provider no longer serves, plus any blocked by policy or region. Each probe is rejected before generation, so it costs no tokens. |
| Search + filter | Find by id or name; switch between all / enabled / disabled. |
| Select all / invert / clear | Bulk edits apply **only to the visible rows**, so a search narrows what they affect. |
| Enable selected / Disable all | Writes exactly the checked ids. Unchecking everything is legal and disables every model. |

The model picker shows this provider as **OpenCode GO Plus**, distinct from the official `OpenCode GO` route.

Save and Test are independent: Save persists, Test only reads. Leaving the key field blank means "keep the stored key" in both. So there is no required order — type, test, then save if it works.

### Retired models

`/v1/models` is an advertising surface, not ground truth: it keeps listing models the provider has already retired. `union-alpha` was still advertised long after every call to it started failing with `Model is unavailable.`, so the plugin can report two different things:

- **No longer in the catalog, possibly retired** — shown on the card with no request at all. The catalog is the documentation of record, and a model it has dropped can no longer have its protocol or capabilities refreshed. Treat this as a hint, not proof: a brand-new model appears on the gateway before the catalog catches up.
- **The provider no longer serves it** — shown after **Check model availability**, which is ground truth. It also separates a retired model from one merely blocked by policy or region, because the two need different fixes.

Either way, the card offers **Remove these models and save**, which commits the reduced selection immediately — that is what the action is for, and it works whether or not you have loaded the model list. The one exception is a checkbox list holding unapplied edits: then it asks you to commit or discard those first rather than overwriting them silently.

In a conversation, `/opencode-go-plus-refresh` performs a full mirror sync.

## Config reference

Namespace `dsh-opencode-go-plus` in `~/.dsh/settings.yaml` (or via the card):

| key | default | description |
|---|---|---|
| `providerRoute` | `opencode-go-plus` | LLM route key this adapter owns |
| `baseURL` | `https://opencode.ai/zen/go` | gateway base (the version segment is added per protocol) |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | credential reference; the secret lives in `~/.dsh/.credentials.yaml` |
| `modelSource` | `catalog` | `catalog` serves everything the catalog lists; `selected` serves exactly `models` |
| `retries` | `3` | transient-failure retries (also the retry policy for chat requests) |
| `timeoutMs` | `15000` | per-attempt timeout for catalog and gateway listing calls |
| `streamTimeoutMs` | `300000` | per-request timeout for a **chat** call. Set explicitly because the Anthropic SDK otherwise applies its own 10-minute default, so a stalled connection hangs the turn instead of failing into the retry path |
| `defaultContextWindow` | `262144` | context window for a model the catalog does not size |
| `defaultMaxTokens` | `32768` | **request** output cap (not the model's capability) |
| `models` | `[]` | the enabled list; meaning depends on `modelSource` |

`modelSource` disambiguates an empty list, so that unchecking every model is not read as "nothing chosen yet":

| `modelSource` | `models` | served |
|---|---|---|
| `catalog` (default) | `[]` | every model the live catalog lists |
| `catalog` | non-empty | just those |
| `selected` | `[]` | **none** |
| `selected` | non-empty | just those |

Entry fields: `id` (required), `name`, `contextWindow`, `maxTokens`, `input` (`["text","image"]`), `reasoning`, `efforts` (thinking levels; the level id is the wire value), `offWire` (the wire spelling of "off" when it is not `off`, e.g. `hy3` uses `"none"`), `api` (`openai-completions` / `anthropic-messages` / `openai-responses`).

## Migrating from a built-in `llm-pi-ai` route

**Nothing has to be removed first.** This plugin claims the route `opencode-go-plus`; the built-in `llm-pi-ai` route normally uses `opencode-go`. Different route keys coexist, and the model picker lists both, so you can compare them side by side and drop whichever you do not want.

The credential reference is the same (`OPENCODE_GO_API_KEY`), so one key serves both.

The easiest migration is not to copy model fields at all: fill in the gateway URL and key on the card, then **Fetch available models** and check what you want. Names, limits, modalities and protocols are filled in from the catalog.

If you do copy the section, these fields carry over unchanged: `baseURL`, `apiKeyEnv`, `models[].id`, `models[].name`, `models[].contextWindow`, `models[].maxTokens`, `models[].input`.

Three things differ:

| `llm-pi-ai` | this plugin | why |
|---|---|---|
| `api` (route-level) | `api` (**per model**) | this plugin's whole point: one route, several protocols. The catalog already sets it, so you rarely write it. |
| `models[].reasoningEfforts` (`{high: "high"}`) | `models[].efforts` (`["high"]`) plus `offWire` | the level id is the wire value; only "off" needs spelling out |
| `models[].compat` | not supported | a pi-ai adapter-layer knob with no equivalent here |

Two behavioural notes:

- **`input: []` means "defer to the catalog"**, exactly as in pi-ai (whose `declaredInput` returns `undefined` for an empty list). Copying `input: []` does **not** strip image support.
- **`maxTokens` is a capability, not a request cap.** pi-ai turns an explicit `maxTokens` into the per-request output limit; here the request cap is `defaultMaxTokens` (32768 by default), clamped by the model's capability. Sending the capability would ask the gateway for e.g. 384k output tokens on every request.

### Removing the old route afterwards

There is nothing to disable by default — `llm-pi-ai` ships dormant, and an `opencode-go` route exists only because it was added. Once this plugin is working you can leave it, but two providers on one gateway means every shared model is listed twice in the picker.

The card detects that: if OpenCode GO is configured on another route, it names it and offers **Remove that route**. That writes only the one key — the rest of that settings section, including other providers, is preserved. The same finding is also logged when the plugin mounts, since the symptom shows up in the picker rather than on that card.

Detection is by **configured route**, not by URL: `opencode-go` is OpenCode GO whether it points at the official domain or a relay, and a route added with no fields at all (`opencode-go: {}`, which is what the Models page writes) still serves the full catalog. A provider that pi-ai merely *offers* to add is not reported, because nothing is configured yet.

**The one thing to check first:** if `agent-default-model` still names the route being removed, the next request fails with `NO_ADAPTER` (`no adapter registered for provider "opencode-go"`). Switch the default model to this plugin's route (`opencode-go-plus`) or another provider, and the removal proceeds. The card refuses the removal while the default model still points there, rather than leaving you with a broken default.

Prefer to do it by hand? **Settings → Models** has a delete button for the route, or delete the `llm-pi-ai.providers.opencode-go` block from `~/.dsh/settings.yaml`.

The credential is untouched either way: both routes read the same `OPENCODE_GO_API_KEY`, so the old route being gone does not affect this plugin.

## Troubleshooting

- **The provider does not appear in Settings → Models.** This is deliberate. DSH's Models page renders only its two hardcoded layouts (`llm-deepseek`, `llm-pi-ai`); for any other namespace it prints a fixed "edit settings.yaml" note and no fields at all. Listing this route there would add a dead entry with nothing to edit, so the plugin stays out. Configure it on the plugin card instead — the chat model picker reads the adapter registry, not that directory, so nothing is lost.
- **A model errors with "has no known wire protocol".** Its stored entry has no `api` and the catalog was unreachable. Enable it from the card while online (which records the protocol), or set `api` on the entry.
- **`Invalid API key` / 401.** The key is wrong or the subscription lapsed. Use Test connection on the card.
- **A model is refused with 403 (policy or region).** The gateway reports a policy block as `DataPolicyError` and a geo-block as `RegionError`, both with 403. Neither is a credential failure, so the plugin keeps them out of `AUTH` — that is the one code DSH's chat and trajectory UI replaces with a fixed "invalid API key" string, discarding the original text. The real message therefore reaches the UI, including the opt-in URL a `DataPolicyError` carries. A 403 is permanent, so it is not retried. For `DataPolicyError`, accept the model's data-use terms at that URL; for `RegionError`, the model is not served in your region.
- **A turn fails with "Connection error." / `PI_AI_ERROR`.** The provider never answered — a dropped socket or a stalled relay. It is classified as `TRANSPORT` and therefore retried per the `retries` setting; `streamTimeoutMs` bounds how long one attempt may hang.
- **An enabled model stops working (`Model is unavailable.`).** See [Retired models](#retired-models). The gateway keeps advertising retired models, so an enabled one can silently rot; **Check model availability** names them and the card can drop them in one click.
- **Occasional 503 from the gateway.** The upstream pool is intermittently saturated; requests are retried per the `retries` setting.
- **Changes not visible.** Restart `dsh web` and hard-refresh the page.

## License

MIT
