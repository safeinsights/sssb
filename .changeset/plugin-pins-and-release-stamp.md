---
'@sssb/kit': patch
'@sssb/tools': patch
'@sssb/create': patch
---

### The plugin enabled at the workflow's commit, and `sssb doctor` reporting both pins

**Kind.** scaffold

**Action.** optional

**What changed.** `@sssb/kit` names the commit it was released from in `dist/release.json`, and `sssb doctor` reports
(never fails) when the commit your `.github/workflows/*.yml` pins SSSB's reusable workflow at, or the one your
`.claude/settings.json` pins SSSB's plugin marketplace at, is not that commit, naming both, and when no plugin is
enabled from that marketplace (naming the ones that are). A workspace
`pnpm create @sssb` writes now has a `.claude/settings.json` that declares SSSB's marketplace (`sssb`) pinned to the
workflow's commit and enables its plugin (`sssb@sssb`: the app-author commands as `/sssb:<command>`, and the
`doc-steward` agent), and a `CLAUDE.md` that imports `.claude/sssb-guide.md`.

**To adopt.** In an existing workspace, write `.claude/settings.json`:
`{ "extraKnownMarketplaces": { "sssb": { "source": { "source": "github", "repo": "safeinsights/sssb", "ref": "<the
commit your workflow pins>" } } }, "enabledPlugins": { "sssb@sssb": true } }`. A commit `ref` needs Claude Code 2.1.324
or later. Each person runs `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.
Keep a line holding `@.claude/sssb-guide.md` in your `CLAUDE.md`. On each upgrade, raise the marketplace's `ref` with
the workflow's pin.

**Now deletable.** Copies of SSSB's app-author commands and `doc-steward` agent kept in your own `.claude/commands/`
and `.claude/agents/`.
