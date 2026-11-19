#!/usr/bin/env bash
# The "changeset required" gate (checks.yml, job `changeset-required`; .changeset/README.md says what a changeset is).
#
# A PR that changes what SSSB hands an adopter must add a changeset: a markdown file in .changeset/. A file holding
# only `---` and `---` is the explicit "no adopter-visible effect" answer. Changesets' own `changeset status` cannot
# be this gate: until ADR-0014's P14 every package was `private`, which status ignores, and what ships also includes
# the starter and the plugin, which no package's status sees. The gate is path-based.
#
# WHAT SHIPS (adopters take it as a package, or copy it as a scaffold):
#   - every `@sssb/*` workspace package under packages/ (read from its package.json, so P4's tools, P6's ESLint
#     plugin, P9's cdk and P12's create are covered the day they land): all its files except tests, stories and a
#     `test-fixture` directory. packages/kit is narrower, because its `files` allowlist is: package.json, src minus
#     tests and stories, and `dist`, which is built when the package is packed (gitignored, so never in a diff) by
#     packages/kit/scripts/, which therefore counts (tests/tooling/changesets.test.ts fails if the allowlist gains
#     an entry this does not know);
#   - apps/starter: the scaffold an adopter keeps and edits, which becomes @sssb/create's template (P12);
#   - plugins/ and .claude-plugin/: the Claude Code plugin and its marketplace, which an adopter's Claude Code loads
#     from this repository at the commit their `.claude/settings.json` pins (P13).
# Not gated: apps/showcase, packages/seed (`@app/seed`), tests, scripts, docs, the lockfile. Some of what an adopter
# receives is outside these paths; .changeset/README.md lists the known gaps.
#
# A RELEASE SNAPSHOT (`packages/<dir>/release-snapshots/*`, ADR-0014 part 10) asks more: a PR that changes one must add
# a changeset filing `minor` for an `@sssb/*` package, since what it guards changing is breaking (below, where it is
# checked). Only the release merge, a PR opened before the cutover, a file merged in from `main` and a snapshot's first
# commit are exempt from it.
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
# A file the PR carries only because it merged `main` in is not the PR's own change (`from_main` below).
set -euo pipefail

: "${BASE_REF:?BASE_REF is required}"
: "${HEAD_REF:?HEAD_REF is required}"
: "${CREATED_AT:?CREATED_AT is required}"
ACTOR="${ACTOR:-}"
HEAD_REPO="${HEAD_REPO:-}"
REPO="${REPO:-}"
SELF=".github/scripts/require-changeset.sh"

# `[A-Za-z0-9]+`, not `[^/]+`: a path may hold a newline, which `[^/]` matches and an extension never does.
NOT_SHIPPED='\.(test|stories)\.[A-Za-z0-9]+$|/test-fixture/'

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

# `-z`: git then prints each path verbatim and NUL-terminated. Without it a path with a non-ASCII character or a quote
# comes out as a C-quoted string, which no pattern below matches, so a shipped file would read as not shipped. Paths
# are matched with `[[ =~ ]]`, never `grep` on a here-string, because grep reads a path with a newline as several
# lines. `--no-renames` so a file moved out of the shipped set still counts as changed.
changed=()
while IFS= read -r -d '' f; do changed+=("$f"); done < <(git diff --no-renames --name-only -z "$base" HEAD)

# Which packages/<dir> are `@sssb/*`: either side of the PR names one (so renaming a package away from `@sssb/*`, or
# deleting it, is a change to what ships), and a manifest that does not parse counts as shipped rather than as not
# one. A directory with no manifest on either side is not a package.
sssb_package() {
  local dir=$1 rev manifest verdict
  for rev in HEAD "$base"; do
    manifest=$(git show "$rev:packages/$dir/package.json" 2>/dev/null || true)
    [ -n "$manifest" ] || continue
    verdict=$(node -e 'try { const n = JSON.parse(require("fs").readFileSync(0, "utf8")).name; console.log(typeof n === "string" && n.startsWith("@sssb/") ? "yes" : "no") } catch { console.log("yes") }' <<<"$manifest")
    [ "$verdict" = "yes" ] && return 0
  done
  return 1
}

# A file this PR carries only because it merged `main` in: the newest commit on main (since main and the base
# diverged) that touched it AND is in this PR's history, and the PR's copy is main's copy as of that commit. A
# hand-applied copy of a hotfix is not that. A file main changed again after the PR last merged it is still exempt:
# only the commits the PR has are looked at.
from_main() {
  [ -n "$mainbase" ] || return 1
  local c
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    git merge-base --is-ancestor "$c" HEAD || continue
    git diff --quiet "$c" HEAD -- "$1" && return 0
    return 1
  done < <(git log --format=%H "$mainbase..origin/main" -- "$1")
  return 1
}
mainbase=$(git merge-base "origin/$BASE_REF" origin/main 2>/dev/null || true)

# `sssb_package` once per package directory, not once per file. Delimited by `/`, which a directory name cannot hold
# (a space or a newline in a name would otherwise join or split entries).
sssb_dirs="/"
other_dirs="/"
is_sssb_dir() {
  case "$sssb_dirs" in *"/$1/"*) return 0 ;; esac
  case "$other_dirs" in *"/$1/"*) return 1 ;; esac
  if sssb_package "$1"; then sssb_dirs+="$1/"; return 0; fi
  other_dirs+="$1/"
  return 1
}

# The changesets this PR adds. What Changesets itself skips: README in any case, the agent files by exact case, and
# dotfiles. A changeset the PR ADDS counts; editing one that is already pending does not (`--diff-filter=A` with
# `--no-renames`, so deleting one and adding a similar one is an add, not a rename).
added=()
while IFS= read -r -d '' f; do added+=("$f"); done < <(git diff --no-renames --name-only -z --diff-filter=A "$base" HEAD -- '.changeset/*.md')
changesets=()
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
  changesets+=("$f")
done

# THE RELEASE SNAPSHOTS (ADR-0014 part 10): `packages/<dir>/release-snapshots/*`, the logical ids of @sssb/cdk's
# stateful resources (a changed one replaces the resource, the Aurora cluster included, on the next `cdk deploy`) and
# the environment a real deployment of the kit must set (a new variable stops every deployment that lacks it). Each is
# a committed file a test holds the code to, so a PR that changes one changed what it guards, and that is breaking: it
# must add a changeset that files `minor` for an `@sssb/*` package. Dependabot is not exempt (a person's commit on its
# branch is the usual way a dependency bump changes one); the release merge (above) and a file merged in from `main`,
# whose own PR carried the changeset, are.
RELEASE_SNAPSHOT='^packages/[^/]+/release-snapshots/'
snapshots=()
for f in ${changed[@]+"${changed[@]}"}; do
  [[ "$f" =~ $RELEASE_SNAPSHOT ]] || continue
  # A snapshot the base does not have yet guards nothing so far: its first commit is not a change to what it records.
  # Its deletion, or a move (`--no-renames` makes one a deletion and an add), is.
  git cat-file -e "$base:$f" 2>/dev/null || continue
  from_main "$f" && continue
  snapshots+=("$f")
done
if [ "${#snapshots[@]}" -gt 0 ]; then
  # The frontmatter as scripts/release.mjs's `changesetReleases` reads it (one `'name': bump` per line, `#` comments,
  # a quoted bump), from HEAD; a file it cannot read files nothing. Prints each changeset that files a minor.
  minors=$(node -e '
    const { execFileSync } = require("node:child_process")
    for (const file of process.argv.slice(1)) {
      let text
      try { text = execFileSync("git", ["show", "HEAD:" + file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) } catch { continue }
      const fm = /^﻿?\s*---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text)
      if (!fm) continue
      const minor = (fm[1] ?? "").split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "").trim()).some((l) =>
        /^(["'\''"]?)(@sssb\/[^"'\''\s:]+)\1\s*:\s*(["'\''"]?)minor\3$/.test(l))
      if (minor) console.log(JSON.stringify(file))
    }
  ' ${changesets[@]+"${changesets[@]}"})
  if [ -z "$minors" ]; then
    echo "::error::This PR changes a release snapshot, which is breaking (ADR-0014 part 10: a replaced stateful resource or a new required environment variable), but adds no changeset that files 'minor' for an @sssb/* package. Add .changeset/<what-changed>.md with \"'@sssb/<package>': minor\" (Kind operator, Action required; template in .changeset/README.md). Changed snapshots:"
    printf '  %s\n' "${snapshots[@]}"
    exit 1
  fi
  echo "This PR changes a release snapshot and adds a minor changeset: $(printf '%s' "$minors" | tr '\n' ' ')"
fi

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
        elif [[ "$f" == packages/kit/src/* || "$f" == packages/kit/scripts/* ]] && ! [[ "$f" =~ $NOT_SHIPPED ]]; then
          :
        else
          continue
        fi
      elif [[ "$f" =~ $NOT_SHIPPED ]]; then
        continue
      fi
      ;;
    apps/starter/*) ;;
    # The Claude Code plugin and its marketplace (P13): an adopter's Claude Code loads them from this repository at the
    # commit their `.claude/settings.json` pins, so a change reaches them when they raise the pin at a release.
    plugins/*|.claude-plugin/*) ;;
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

real=${#changesets[@]}
if [ "$real" -gt 0 ]; then
  echo "This PR changes what ships and adds $real changeset file(s)."
  exit 0
fi

echo "::error::This PR changes what ships to adopters but adds no changeset. Add .changeset/<what-changed>.md (template in .changeset/README.md), or an empty one (two lines, '---' and '---') if adopters would see no difference. Changed shipped files:"
printf '  %s\n' "${shipped[@]}"
exit 1
