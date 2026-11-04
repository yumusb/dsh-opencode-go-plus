# Test scaffolding

## Why this exists

`lib/dsh-compat.js` imports three host packages that only exist inside the DSH
app bundle (`@deepseek-ai/dsh-llm`, `dsh-credentials`,
`dsh-launch-environment`). They are not published, so a plain `node --test` has
no way to resolve them and every test that touches the adapter would fail to
load.

`host-shim/` holds behavior-equivalent stand-ins for exactly the exports this
package uses. They are test scaffolding and are excluded from the published
tarball (`package.json` `files` lists only `lib`, `docs`, `locale`, `assets`).

## Wiring it up

`node_modules/` is gitignored, so each checkout links the pieces once:

```powershell
$repo = (Get-Location)
$nm = Join-Path $repo 'node_modules'
New-Item -ItemType Directory -Force -Path (Join-Path $nm '@deepseek-ai'), (Join-Path $nm '@earendil-works') | Out-Null
foreach ($name in 'dsh-llm','dsh-credentials','dsh-launch-environment') {
  New-Item -ItemType Junction -Path (Join-Path $nm "@deepseek-ai\$name") -Target (Join-Path $repo "test\support\host-shim\$name") | Out-Null
}
# pi-ai is a real dependency; link the copy the DSH profile already installed
New-Item -ItemType Junction -Path (Join-Path $nm '@earendil-works\pi-ai') -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@earendil-works\pi-ai" | Out-Null
```

On macOS/Linux use `ln -s` with the same targets.

Then:

```bash
node --test
```

## What the shims do NOT cover

Anything the host does at runtime: settings forms, the client bundle, model
selection UI, credentials storage, attachments. Tests that need those run only
inside DSH, and the fixtures under `fixtures/` are the record of what real
traffic looked like.
