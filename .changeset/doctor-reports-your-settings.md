---
'@sssb/tools': patch
---

### `sssb doctor` reports your own GitHub settings and plugin install

**Kind.** none

**Action.** none

**What changed.** `sssb doctor` now also reports, without ever failing or changing anything, the settings only you can
make. When `gh` is signed in: whether `sssb / all-checks` is a required check on your repository's default branch (a
ruleset or branch protection), whether private vulnerability reporting is on, and, for a private repository in an
organization, whether its Actions policy lets it call SSSB's reusable workflow. Locally: whether the Claude Code plugin
your `.claude/settings.json` enables is installed (`claude plugin install <plugin> --scope project`). It makes
read-only GitHub requests through `gh`; a `gh` that is missing, signed out or offline, or a setting your account may not
read, gives "not checked" and the reason. None of it runs when `CI` is set.

**To adopt.** Nothing to do. After you upgrade, a local `pnpm exec sssb doctor` prints up to four more lines (`github:`
and `claude plugin:`), each `ok`, or `report` with what to change: the report never changes the exit code. Run
`gh auth login` first if you want the GitHub lines; in CI doctor prints one line saying it skipped them.
