#!/usr/bin/env bash
# scripts/release.sh — Cut a versioned release of OnePlatform.
#
# Usage:  ./scripts/release.sh [major|minor|patch]
#
# What it does:
#   1. Guards: must be on main, clean working tree, semver arg supplied.
#   2. Bumps the version in root package.json using Node semver logic.
#   3. Moves CHANGELOG.md [Unreleased] → [<new-version>] with today's date
#      and adds a fresh empty [Unreleased] section above it.
#   4. Commits the two file changes.
#   5. Creates an annotated git tag (v<version>).
#   6. Pushes both the commit and the tag — the GitHub Actions release
#      workflow fires automatically on the tag push.

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed or not on PATH"
}

# ── Arg validation ────────────────────────────────────────────────────────────

BUMP="${1:-}"
case "$BUMP" in
  major|minor|patch) ;;
  *) die "Usage: $0 [major|minor|patch]" ;;
esac

# ── Prereqs ───────────────────────────────────────────────────────────────────

require_cmd git
require_cmd node
require_cmd jq

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Guard: must be on main ────────────────────────────────────────────────────

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  die "Releases must be cut from main. Current branch: '$CURRENT_BRANCH'"
fi

# ── Guard: working directory must be clean ────────────────────────────────────

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working directory is not clean. Commit or stash your changes first."
fi

# ── Read current version ──────────────────────────────────────────────────────

PACKAGE_JSON="$REPO_ROOT/package.json"
CURRENT_VERSION="$(jq -r '.version' "$PACKAGE_JSON")"

# Validate it's a proper semver (X.Y.Z) before we touch anything
if ! [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Current version '$CURRENT_VERSION' in package.json is not a valid semver X.Y.Z"
fi

# ── Compute new version via Node (avoids a dependency on semver-tool) ─────────

NEW_VERSION="$(node -e "
const [major, minor, patch] = '${CURRENT_VERSION}'.split('.').map(Number);
switch ('${BUMP}') {
  case 'major': console.log((major + 1) + '.0.0'); break;
  case 'minor': console.log(major + '.' + (minor + 1) + '.0'); break;
  case 'patch': console.log(major + '.' + minor + '.' + (patch + 1)); break;
}
")"

TAG="v${NEW_VERSION}"
TODAY="$(date -u +%Y-%m-%d)"

echo "Bumping $CURRENT_VERSION → $NEW_VERSION ($BUMP)"

# ── Guard: tag must not already exist ─────────────────────────────────────────

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "Tag '$TAG' already exists. Has this version been released?"
fi

# ── Bump version in package.json ──────────────────────────────────────────────

# Use node so we don't need jq write-back (jq -n ... is fine but this is explicit)
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
"

echo "  package.json → $NEW_VERSION"

# ── Update CHANGELOG.md ───────────────────────────────────────────────────────

CHANGELOG="$REPO_ROOT/CHANGELOG.md"

if [ ! -f "$CHANGELOG" ]; then
  die "CHANGELOG.md not found at $REPO_ROOT. Create it first."
fi

# Verify there's an [Unreleased] section to promote
if ! grep -q "^## \[Unreleased\]" "$CHANGELOG"; then
  die "CHANGELOG.md has no '## [Unreleased]' section. Add release notes before running this script."
fi

# Replace the [Unreleased] header with [version] + date,
# and prepend a new empty [Unreleased] section.
UNRELEASED_BLOCK="## [Unreleased]\n\n## [$NEW_VERSION] - $TODAY"
# Use perl for reliable in-place multiline replacement across all platforms
perl -i -0pe "s/## \[Unreleased\]/$UNRELEASED_BLOCK/" "$CHANGELOG"

# Append comparison links at the bottom of the file.
# We keep it idempotent: only add the new [version] link if it's not already there.
REPO_URL="$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')"
if [ -n "$REPO_URL" ] && ! grep -q "^\[$NEW_VERSION\]:" "$CHANGELOG"; then
  # Update the [Unreleased] comparison link to point from new version to HEAD
  if grep -q "^\[Unreleased\]:" "$CHANGELOG"; then
    perl -i -pe "s|^\[Unreleased\]:.*|\[Unreleased\]: $REPO_URL/compare/$TAG...HEAD\n[$NEW_VERSION]: $REPO_URL/compare/v${CURRENT_VERSION}...$TAG|" "$CHANGELOG"
  else
    printf "\n[Unreleased]: %s/compare/%s...HEAD\n[%s]: %s/compare/v%s...%s\n" \
      "$REPO_URL" "$TAG" "$NEW_VERSION" "$REPO_URL" "$CURRENT_VERSION" "$TAG" >> "$CHANGELOG"
  fi
fi

echo "  CHANGELOG.md → promoted [Unreleased] to [$NEW_VERSION]"

# ── Commit & tag ──────────────────────────────────────────────────────────────

git add "$PACKAGE_JSON" "$CHANGELOG"
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "OnePlatform $TAG"

echo "  git commit + tag $TAG created"

# ── Push ──────────────────────────────────────────────────────────────────────

git push origin main
git push origin "$TAG"

echo ""
echo "Released $TAG — GitHub Actions release workflow is now running."
echo "Watch progress at: $(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's|git@github.com:|https://github.com/|')/actions"
