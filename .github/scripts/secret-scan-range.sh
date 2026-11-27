#!/usr/bin/env bash
# Which commits does the secret scan read? checks.yml's `secret-scan` job asks this and hands the answer to gitleaks as
# `--log-opts`. Without one, gitleaks walks `git log --all`: every branch on the remote, which a full-history checkout
# fetches. A secret-like string on one branch then failed the scan on every other open pull request, and the pressure
# fell on the wrong people: each author saw a finding in a file their pull request never touched.
#
#   pull_request  <base sha>..<head sha>: the pull request's own commits, including one it added a secret in and
#                 deleted again (a secret committed then deleted is still leaked, which is why the checkout is
#                 full-depth). Commits reachable from the base are not read here; they were read when they landed.
#   push          HEAD: the whole history of the branch that was pushed (only `main` triggers the workflow), never
#                 `--all`, so whatever reaches `main` is still scanned in full.
#   anything else fails: a new trigger decides its own range here, in review, rather than silently scanning
#                 everything (the failure this script exists to end) or nothing.
#
# Inputs, all environment: EVENT_NAME (github.event_name), and for a pull request BASE_SHA and HEAD_SHA
# (github.event.pull_request.base.sha and .head.sha). They are passed as environment, never interpolated into the
# script, so a value cannot become shell. Prints the range alone on stdout, one line with no space in it:
# gitleaks splits `--log-opts` on spaces, and warns about a value that carries its own quotes. Diagnostics go to
# stderr; a failure exits non-zero having printed nothing, so a caller that captures the range and runs under `set -e`
# stops. The checkout must hold both commits of a pull request (fetch-depth 0).
set -euo pipefail

fail() {
    echo "secret-scan-range: $1" >&2
    exit 1
}

# A full object id, SHA-1 or SHA-256, and a commit this clone has: a short or odd value would be read by git as a ref
# name or an option, and a missing commit makes gitleaks fail with an error that does not name the cause.
commit() {
    local name=$1 value=${2:-}
    [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "$name is not a full commit id (${value:-unset})"
    git cat-file -e "${value}^{commit}" 2> /dev/null || fail "$name ($value) is not a commit in this clone: check out with fetch-depth 0"
}

case "${EVENT_NAME:-}" in
pull_request)
    commit BASE_SHA "${BASE_SHA:-}"
    commit HEAD_SHA "${HEAD_SHA:-}"
    echo "${BASE_SHA}..${HEAD_SHA}"
    ;;
push)
    echo HEAD
    ;;
*)
    fail "no range for the event '${EVENT_NAME:-unset}': add one here before the workflow runs on it"
    ;;
esac
