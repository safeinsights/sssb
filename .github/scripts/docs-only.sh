#!/usr/bin/env bash
# Is this run a pull request that changes only documentation? checks.yml runs it in its `changes` job (for the reusable
# workflow's `docs-only` input) and in each of its own jobs with a fast path: true lets a job skip its expensive steps,
# which none of these paths can affect. The job still RUNS and reports a conclusion, so no required check goes missing (docs/decision-log.md,
# "A fast path for docs-only pull requests").
#
# DOCS-ONLY means every path the pull request changes is under one of:
#   - docs/, except docs/releases/ (release.mjs writes a release's notes there, and the release rehearsal reads them);
#   - .claude/future-tasks/.
# Nothing else, however inert it looks: everything that ships (packages/, apps/, plugins/, the guide) is code here,
# and a path joins this list only with evidence that no job with a fast path reads it (root markdown has none yet).
# The job that reads docs (lint-typecheck-unit: Prettier, the doc-path gate, the plugin, generator and release-notes
# tests) and the cheap gates (release-plan, changeset-required, secret-scan, repo-checks' bidi scan) have no fast path.
#
# The answer is false, and every job does its whole work, unless all of this holds:
#   - the event is `pull_request` (a push to main, the release path, always runs everything);
#   - HEAD is the pull request's merge commit, two parents, as actions/checkout leaves it for `pull_request`. Its
#     first parent is the base branch's tip when the run started, so the diff is what the pull request changes on top
#     of the CURRENT base: a branch brought up to date gets a new run, judged on its new merge commit;
#   - that diff is not empty, and names no path outside the list above. With no rename detection a rename lists its
#     old path too, so moving a file from packages/ into docs/ is not docs-only; a path git quotes (an unusual
#     character) matches nothing, so it is not docs-only either.
#
# Inputs, all environment: EVENT_NAME (github.event_name). The checkout needs depth 2 (the merge commit's parents).
# Writes `docs-only=true|false` to $GITHUB_OUTPUT when it is set, prints the answer and why either way, and exits 0. If
# git itself fails it exits non-zero having written nothing: the `changes` job (whose step may fail) then gives the
# reusable workflow false, and any other job fails, red rather than fast.
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

# Plumbing, not `git diff`: diff-tree reads no diff.* configuration (`diff.ignoreSubmodules` would hide a gitlink),
# detects no renames unless asked, and quotes an unusual path whatever core.quotePath says.
files=$(git -c core.quotePath=true diff-tree -r --name-only --ignore-submodules=none HEAD^1 HEAD)
[ -n "$files" ] || answer false "the pull request changes nothing against its base: everything runs"

while IFS= read -r file; do
    case "$file" in
    docs/releases/*) answer false "$file is a release's notes: everything runs" ;;
    docs/* | .claude/future-tasks/*) ;;
    *) answer false "$file is not documentation: everything runs" ;;
    esac
done <<< "$files"

answer true "only documentation changed ($(wc -l <<< "$files" | tr -d ' ') files): the jobs with a fast path skip their heavy steps"
