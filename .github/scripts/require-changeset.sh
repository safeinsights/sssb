#!/usr/bin/env bash
# The "changeset required" gate (checks.yml, job `changeset-required`; .changeset/README.md says what a changeset is).
#
# A PR that changes what SSSB hands an adopter must add a changeset: a markdown file in .changeset/. A file holding
# only `---` and `---` is the explicit "no adopter-visible effect" answer. Changesets' own `changeset status` cannot
# be this gate: every package is `private` until ADR-0014's P14, and status ignores private packages, so it would
# pass for any change. The gate is path-based.
#
# WHAT SHIPS (adopters take it as a package, or copy it as a scaffold):
#   - every `@sssb/*` workspace package under packages/ (read from its package.json, so P4's tools, P6's ESLint
#     plugin, P9's cdk and P12's create are covered the day they land): all its files except tests, stories and a
#     `test-fixture` directory. packages/kit is narrower, because its `files` allowlist is: package.json, src minus
#     tests and stories, plus the seam-conformance tests the allowlist names (the list below; tests/tooling/
#     changesets.test.ts fails if it drifts from the manifest);
#   - apps/starter: the scaffold an adopter keeps and edits, which becomes @sssb/create's template (P12).
# Not shipped: apps/showcase, packages/seed (`@app/seed`), tests, scripts, docs, infra, the lockfile. Known gaps are
# listed in .changeset/README.md.
#
# Inputs, all environment: BASE_REF (the PR's base branch), HEAD_REF (its head branch), CREATED_AT (the PR's creation
# time, ISO 8601), ACTOR (who opened it), HEAD_REPO and REPO (the head's repository and this one; the release-merge
# exemption needs them equal). The checkout needs full history and `origin/$BASE_REF`. Exit 0 passes and prints why;
# exit 1 fails with an ::error:: line naming the files.
#
# Exempt, and said so in the output:
#   - the release merge: from `integration` into `main`, in this repository (a fork's branch of that name is not it);
#   - a PR by dependabot[bot], which cannot write a changeset, unless it changes the kit's peerDependencies (a raised
#     peer floor is breaking, ADR-0014 part 10);
#   - a PR opened before this script reached its base branch (the first-parent commit that added it is the cutover,
#     so no date is written here).
# A file the PR carries only because it merged `main` in (it equals origin/main's copy, and main changed it since the
# branches diverged) is not the PR's own change.
set -euo pipefail

: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_REF:?HEAD_REF is required}"
: "${CREATED_AT:?CREATED_AT is required}"
ACTOR="${ACTOR:-}"
HEAD_REPO="${HEAD_REPO:-}"
REPO="${REPO:-}"
SELF=".github/scripts/require-changeset.sh"

# Tests the `files` allowlist of packages/kit/package.json ships anyway.
KIT_SHIPPED_TESTS='^packages/kit/src/(i18n/namespaces\.test\.ts|i18n/messages-parity\.test\.ts|db/rls-pglite\.test\.ts|db/migrate\.test\.ts|server-lib/demo-presets-seam\.test\.ts)$'
NOT_SHIPPED='\.(test|stories)\.[^/]+$|/test-fixture/'

if [ "$BASE_REF" = "main" ] && [ "$HEAD_REF" = "integration" ] && [ -n "$REPO" ] && [ "$HEAD_REPO" = "$REPO" ]; then
  echo "Release merge from integration; its changes carried their own changesets."
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

# `-z` and quotePath off: without them git prints a path with a non-ASCII character or a quote as a C-quoted string,
# which no pattern below matches, so a shipped file would read as not shipped. `--no-renames` so a file moved out of
# the shipped set still counts as changed. Captured, not piped into `grep -q`: under pipefail an early-exiting grep
# can SIGPIPE git and turn a match into a silent pass.
changed=()
while IFS= read -r -d '' f; do changed+=("$f"); done < <(git -c core.quotePath=false diff --no-renames --name-only -z "$base" HEAD)

# Which packages/<dir> are `@sssb/*`, from HEAD's manifest or, for a package the PR deletes, the base's.
sssb_package() {
  local dir=$1 manifest
  manifest=$(git show "HEAD:packages/$dir/package.json" 2>/dev/null || git show "$base:packages/$dir/package.json" 2>/dev/null || true)
  [ -n "$manifest" ] || return 1
  node -e 'const n = JSON.parse(require("fs").readFileSync(0, "utf8")).name; process.exit(typeof n === "string" && n.startsWith("@sssb/") ? 0 : 1)' <<<"$manifest"
}

# A file this PR carries only because it merged `main` in: equal to main's copy, and main changed it since main and
# the base diverged. Skipped when there is no origin/main (a repository whose base is its only branch).
from_main() {
  [ -n "$mainbase" ] || return 1
  git diff --quiet origin/main HEAD -- "$1" && ! git diff --quiet "$mainbase" origin/main -- "$1"
}
mainbase=$(git merge-base "origin/$BASE_REF" origin/main 2>/dev/null || true)

# `sssb_package` once per package directory, not once per file.
sssb_dirs=" "
other_dirs=" "
is_sssb_dir() {
  case "$sssb_dirs" in *" $1 "*) return 0 ;; esac
  case "$other_dirs" in *" $1 "*) return 1 ;; esac
  if sssb_package "$1"; then sssb_dirs+="$1 "; return 0; fi
  other_dirs+="$1 "
  return 1
}

shipped=()
for f in ${changed[@]+"${changed[@]}"}; do
  [ -n "$f" ] || continue
  case "$f" in
    packages/*/*)
      dir=${f#packages/}
      dir=${dir%%/*}
      is_sssb_dir "$dir" || continue
      if [ "$dir" = kit ]; then
        if [ "$f" = packages/kit/package.json ]; then
          :
        elif [[ "$f" == packages/kit/src/* ]] && { grep -qE "$KIT_SHIPPED_TESTS" <<<"$f" || ! grep -qE "$NOT_SHIPPED" <<<"$f"; }; then
          :
        else
          continue
        fi
      elif grep -qE "$NOT_SHIPPED" <<<"$f"; then
        continue
      fi
      ;;
    apps/starter/*) ;;
    *) continue ;;
  esac
  from_main "$f" && continue
  shipped+=("$f")
done

# Dependabot is exempt unless it raised or changed a peer floor of the kit.
if [ "$ACTOR" = "dependabot[bot]" ]; then
  peers_changed=$(node -e '
    const { execFileSync } = require("node:child_process")
    const peers = (rev) => {
      try { return JSON.stringify(JSON.parse(execFileSync("git", ["show", rev + ":packages/kit/package.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).peerDependencies ?? {}) } catch { return "" }
    }
    console.log(peers(process.argv[1]) === peers("HEAD") ? "no" : "yes")
  ' "$base")
  if [ "$peers_changed" = "no" ]; then
    echo "Dependabot cannot write a changeset and left the kit's peer floor alone; not checked."
    exit 0
  fi
fi

if [ "${#shipped[@]}" -eq 0 ]; then
  echo "No file this PR changes ships to adopters; no changeset needed."
  exit 0
fi

# What Changesets itself skips: README in any case, the agent files by exact case, and dotfiles. A changeset the PR
# ADDS counts; editing one that is already pending does not (`--diff-filter=A` with `--no-renames`, so deleting one
# and adding a similar one is an add, not a rename).
added=()
while IFS= read -r -d '' f; do added+=("$f"); done < <(git -c core.quotePath=false diff --no-renames --name-only -z --diff-filter=A "$base" HEAD -- '.changeset/*.md')
real=0
for f in ${added[@]+"${added[@]}"}; do
  case "$f" in
    .changeset/[!./]*.md) ;;
    *) continue ;;
  esac
  case "$f" in
    .changeset/*/*) continue ;;
    .changeset/AGENTS.md | .changeset/CLAUDE.md | .changeset/GEMINI.md) continue ;;
  esac
  lower=$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')
  [ "$lower" = ".changeset/readme.md" ] && continue
  real=$((real + 1))
done

if [ "$real" -gt 0 ]; then
  echo "This PR changes what ships and adds $real changeset file(s)."
  exit 0
fi

echo "::error::This PR changes what ships to adopters but adds no changeset. Add .changeset/<what-changed>.md (template in .changeset/README.md), or an empty one (two lines, '---' and '---') if adopters would see no difference. Changed shipped files:"
printf '  %s\n' "${shipped[@]}"
exit 1
