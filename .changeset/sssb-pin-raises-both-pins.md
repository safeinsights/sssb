---
'@sssb/tools': patch
---

### `sssb pin` raises both of your pins to the release commit

**Kind.** none

**Action.** optional

**What changed.** A new command, `pnpm exec sssb pin`, reads the release commit the installed `@sssb/kit` records
(`dist/release.json`) and writes it into your two pins on SSSB's repository: the reusable workflow's `uses:` line in
`.github/workflows/*.yml` and the `ref` of the plugin marketplace in `.claude/settings.json`. It prints each pin it
changed and the commit it replaced, changes nothing in a pin that is already current, and edits only that text, so the
formatting of both files is kept; a version in the `uses:` line's comment (`# @sssb/create 0.2.0`, `# v0.2.0`) moves
with it, and a comment of your own stays. It refuses, writing nothing, when there is no commit to read (SSSB's own
repository, or a kit packed by hand) or a file is not the shape it edits: no workflow calls SSSB's reusable workflow,
or `.claude/settings.json` is not JSON or declares no marketplace from SSSB's repository. A workspace with no
`.claude/settings.json` has the workflow pin raised alone. "Upgrading to this release" in the notes and `sssb doctor`'s
report of a pin that differs now name it.

**To adopt.** Optional. At your next upgrade, after you install the new packages, run `pnpm exec sssb pin` in place of
editing the `uses:` line and the marketplace's `ref` by hand, read the diff of the two files, and commit it with the
package versions. Each person then runs `claude plugin marketplace update sssb` and
`claude plugin update sssb@sssb --scope project`, as before.

**Now deletable.** Nothing in your code. The two hand edits the release notes asked of you on every upgrade, and any
script of your own that copies the release commit into those two files.
