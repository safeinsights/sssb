#!/usr/bin/env bash
# The "changeset required" gate (checks.yml, job `changeset-required`; .changeset/README.md says what a changeset is).
#
# A PR that changes what SSSB hands an adopter must add a changeset: a markdown file in .changeset/. `pnpm exec
# changeset add --empty`'s equivalent, a file holding only `---` and `---`, is the explicit "no adopter-visible
# effect" answer. Changesets' own `changeset status` cannot be this gate: every package is `private` until
# ADR-0014's P14, and status ignores private packages, so it would pass for any change. The gate is path-based.
#
# WHAT SHIPS (adopters take it as a package or copy it as a scaffold):
#   - packages/kit/package.json and everything its `files` allowlist ships: packages/kit/src, minus tests and
#     stories, plus the seam-conformance tests the allowlist names (the list below; tests/tooling/changesets.test.ts
#     fails if it drifts from the manifest);
#   - apps/starter: the scaffold an adopter keeps and edits.
# Not shipped: apps/showcase, packages/seed, packages/kit/test-fixture, tests, scripts, docs, infra, the lockfile.
#
# Inputs, all environment: BASE_REF (the PR's base branch), HEAD_REF (its head branch), CREATED_AT (the PR's
# creation time, ISO 8601), ACTOR (who opened it; defaults to none). The checkout needs full history and
# `origin/$BASE_REF`. Exit 0 passes and prints why; exit 1 fails with an ::error:: line naming the files.
#
# Exempt, and said so in the output:
#   - a PR from `integration`: the release merge, whose parts each carried a changeset;
#   - a PR by dependabot[bot], which cannot write one;
#   - a PR opened before this script reached its base branch (the first-parent commit that added it is the
#     cutover, so no date is written here).
set -euo pipefail

: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_REF:?HEAD_REF is required}"
: "${CREATED_AT:?CREATED_AT is required}"
ACTOR="${ACTOR:-}"
SELF=".github/scripts/require-changeset.sh"

# Tests the `files` allowlist of packages/kit/package.json ships anyway.
SHIPPED_TESTS='^packages/kit/src/(i18n/namespaces\.test\.ts|i18n/messages-parity\.test\.ts|db/rls-pglite\.test\.ts|db/migrate\.test\.ts|server-lib/demo-presets-seam\.test\.ts)$'
KIT_NOT_SHIPPED='\.(test|stories)\.[^/]+$'

if [ "$HEAD_REF" = "integration" ]; then
  echo "Release merge from integration; its changes carried their own changesets."
  exit 0
fi
if [ "$ACTOR" = "dependabot[bot]" ]; then
  echo "Dependabot cannot write a changeset; not checked."
  exit 0
fi

cutover=$(git log --first-parent --format=%cI "origin/$BASE_REF" -- "$SELF" | tail -n 1)
if [ -z "$cutover" ]; then
  echo "origin/$BASE_REF does not require changesets yet; not checked."
  exit 0
fi
# Node parses the timestamps: BSD date (macOS) has no `-d`, and this runs under both.
epoch() { node -e 'console.log(Date.parse(process.argv[1]) / 1000)' "$1"; }
if [ "$(epoch "$CREATED_AT")" -lt "$(epoch "$cutover")" ]; then
  echo "Opened before origin/$BASE_REF required changesets; not checked."
  exit 0
fi

base=$(git merge-base "origin/$BASE_REF" HEAD)

# Captured in variables, not piped into `grep -q`: under pipefail an early-exiting grep can SIGPIPE git and turn a
# match into a silent pass. `--no-renames` so a file moved out of the shipped set still counts as changed.
changed=$(git diff --no-renames --name-only "$base" HEAD)
shipped=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    packages/kit/package.json) shipped+="$f"$'\n' ;;
    packages/kit/src/*)
      if grep -qE "$SHIPPED_TESTS" <<<"$f" || ! grep -qE "$KIT_NOT_SHIPPED" <<<"$f"; then shipped+="$f"$'\n'; fi
      ;;
    apps/starter/*) shipped+="$f"$'\n' ;;
  esac
done <<<"$changed"

if [ -z "$shipped" ]; then
  echo "No file this PR changes ships to adopters; no changeset needed."
  exit 0
fi

# What Changesets itself skips: README in any case, the agent files by exact case, and dotfiles. Subdirectories
# are not read at all, which the pattern's `[^/.][^/]*` also encodes.
added=$(git diff --name-only --diff-filter=AM "$base" HEAD -- '.changeset/*.md')
real=$(printf '%s\n' "$added" | grep -E '^\.changeset/[^/.][^/]*\.md$' |
  grep -viE '^\.changeset/readme\.md$' |
  grep -vE '^\.changeset/(AGENTS|CLAUDE|GEMINI)\.md$' | grep -c . || true)

if [ "$real" -gt 0 ]; then
  echo "This PR changes what ships and adds $real changeset file(s)."
  exit 0
fi

echo "::error::This PR changes what ships to adopters but adds no changeset. Add .changeset/<what-changed>.md (template in .changeset/README.md), or an empty one (two lines, '---' and '---') if adopters would see no difference. Changed shipped files:"
printf '%s' "$shipped" | sed 's/^/  /'
exit 1
