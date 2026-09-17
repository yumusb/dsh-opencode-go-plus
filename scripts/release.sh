#!/usr/bin/env bash
# Release helper: run tests, bump version, commit, tag, push. GitHub Actions then
# publishes to npm via trusted publishing (OIDC) — no token or secret involved.
# See docs/RELEASE.md for the one-time setup.
#
# Usage:
#   ./scripts/release.sh          # patch: 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor    # minor: 1.0.0 -> 1.1.0
#   ./scripts/release.sh major    # major: 1.0.0 -> 2.0.0
#
# Prerequisites:
#   - clean working tree
#   - an `origin` remote you can push to
#   - npm trusted publisher configured for this repo (see docs/RELEASE.md)
set -euo pipefail

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "usage: $0 [patch|minor|major]" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

echo "→ tests"
node --test

# npm version prints the new version with a leading "v" (v1.0.1), which is
# exactly the tag shape .github/workflows/npm-publish.yml triggers on.
NEW_VERSION="$(npm version "$LEVEL" --no-git-tag-version)"
echo "→ bump: $NEW_VERSION"

git add package.json
git commit -m "chore: release $NEW_VERSION"
git tag "$NEW_VERSION"
git push origin main
git push origin "$NEW_VERSION"

echo "✓ released $NEW_VERSION — GitHub Actions is publishing to npm now."
echo "  watch: https://github.com/yumusb/dsh-opencode-go-plus/actions"
