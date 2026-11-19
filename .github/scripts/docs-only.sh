#!/usr/bin/env bash
# Is this run a pull request that changes only documentation? checks.yml's `changes` job runs it, and every job with a
# fast path (`docs-only` below) reads its answer: true lets that job skip its expensive steps, which none of these
# paths can affect. The job still RUNS and reports a conclusion, so no required check goes missing (docs/decision-log.md,
# "A fast path for docs-only pull requests").
#
# DOCS-ONLY means every path the pull request changes is under one of:
#   - docs/, except docs/releases/ (release.mjs writes a release's notes there, and the release rehearsal reads them);
#   - .claude/future-tasks/.
# Nothing else, however inert it looks: everything that ships (packages/, apps/, plugins/, the guide) is code here,
# and a path joins this list only with evidence that no job with a fast path reads it (root markdown has none yet).
# The jobs that read docs (lint-typecheck-unit: Prettier, the doc-path gate, the plugin, generator and release-notes
# tests) and the cheap gates have no fast path at all.
#
# The answer is false, and every job does its whole work, unless all of this holds:
#   - the event is `pull_request` (a push to main, the release path, always runs everything);
#   - HEAD is the pull request's merge commit, two parents, as actions/checkout leaves it for `pull_request`. Its
#     first parent is the base branch's tip when the run started, so the diff is what the pull request changes on top
#     of the CURRENT base: a branch brought up to date gets a new run, judged on its new merge commit;
#   - that diff is not empty, and names no path outside the list above. `--no-renames` lists a rename's old path
#     too, so moving a file from packages/ into docs/ is not docs-only; a path git quotes (an unusual character)
#     matches nothing, so it is not docs-only either.
#
# Inputs, all environment: EVENT_NAME (github.event_name). The checkout needs depth 2 (the merge commit's parents).
# Writes `docs-only=true|false` to $GITHUB_OUTPUT when it is set, and prints the answer and why either way. Exits 0
# unless git itself fails, so an answer is always written before anything that could stop the job.
set -euo pipefail

answer() {
    echo "docs-only=$1"
    echo "$2"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "docs-only=$1" >> "$GITHUB_OUTPUT"; fi
    exit 0
}

[ "${EVENT_NAME:-}" = pull_request ] || answer false "not a pull request (${EVENT_NAME:-unset}): everything runs"

parents=$(git rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')
[ "$parents" = 3 ] || answer false "HEAD is not a pull request's merge commit ($((parents - 1)) parents): everything runs"

files=$(git diff --no-renames --name-only HEAD^1 HEAD)
[ -n "$files" ] || answer false "the pull request changes nothing against its base: everything runs"

while IFS= read -r file; do
    case "$file" in
    docs/releases/*) answer false "$file is a release's notes: everything runs" ;;
    docs/* | .claude/future-tasks/*) ;;
    *) answer false "$file is not documentation: everything runs" ;;
    esac
done <<< "$files"

answer true "only documentation changed ($(wc -l <<< "$files" | tr -d ' ') files): the jobs with a fast path skip their heavy steps"
