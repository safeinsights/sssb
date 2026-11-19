# P14 must leave Changesets' pre mode, and the release scripts do not yet know how

**Priority:** P2 · **Status:** open
**Found by:** the reviews of ADR-0014's P7 (`feat/release-candidate`), 2026-11-18. Reproduced on a scratch clone by the
independent review; read from `@changesets/assemble-release-plan@7.0.0` by the code review.

## The gap

Until P14 every release is a release candidate: `.changeset/pre.json` holds pre mode `rc`, and Changesets 3 moves each
changeset it consumes to `.changeset/pre/` (`docs/runbooks/release-app.md`). `scripts/release.mjs` reads only that
state:

- `preStateOf` accepts exactly `{"mode": "pre", "tag": "rc"}` or no file. Changesets' own way out, `changeset pre
exit`, writes `"mode": "exit"`, which it refuses.
- `loadWorkspace` never counts a `pre/` changeset as pending, and `verifyRelease` never accepts one being deleted.

So the first plain release cannot be cut. With `pre.json` deleted and `private` removed, Changesets treats every
`.changeset/pre/*.md` as pending again, bumps from them and deletes them: `prepare` reports "no changesets are pending"
when only those remain (a green run with no release), and with a new changeset it versions, and `verify-release` then
refuses the deletions in the `push` job.

## The design sketched

At P14, in the same PR that removes `private` from the fixed group:

1. Leave pre mode by deleting `.changeset/pre.json` (or teach `preStateOf` `"mode": "exit"`, which Changesets' plan
   treats as releasing every `pre/` changeset; pick one and test it against the real CLI).
2. Outside pre mode, `loadWorkspace` counts `pre/` changesets as pending, and `verifyRelease` accepts each one's
   deletion as it accepts a pending changeset's, and computes the version from all of them (the group's version is a
   candidate's, `0.x.y-rc.N`, whose `inc` is `0.x.y`).
3. The release notes: the first plain release's notes are every changeset since the last plain release, the `pre/` ones
   included, or a pointer to the candidates' notes; decide which, since `scripts/release-notes.mjs` reads only
   `.changeset/*.md`.
4. A test that runs the real CLI from a group at `0.2.0-rc.3` with `pre/` changesets to `0.2.0`, through `prepare` and
   `verify-release`, as `tests/tooling/release.test.ts` does for candidates.
5. Pack and consume's pages shape proves a release candidate's install recipe (`notesRecipe` in
   `scripts/pack-and-consume.mjs`, from `candidateNotes`, which only an rc has) and says it is skipped for any other
   version. A plain release's install lines (from npm, by version) need their own proof in its place.

## Resolved — 2026-11-18 (`release/p14-first-npm-release`)

Built in the PR that took `private` off the fixed group, so the merge of `int-p14` into `main` releases 0.2.0 to npm.

1. **Pre mode is left by deleting `.changeset/pre.json`**, not by `changeset pre exit`. `preStateOf` still accepts only
   `{"mode": "pre", "tag": "rc"}` or no file, so `"mode": "exit"` stays a state no reader has to know. Measured in
   `@changesets/assemble-release-plan` 7.0.0: with no pre state `getRelevantChangesets` returns every changeset, `pre/`
   ones included, and `incrementVersion` applies semver's `inc` alone, so `0.2.0-rc.2` takes a patch or a minor to
   `0.2.0`; `apply-release-plan` then deletes every one. Exit mode would differ only in forcing a patch with no
   changeset at all, which the group never lacks here, and in deleting `pre.json` in the release commit, which
   `verify-release` would then have to accept.
2. **Out of pre mode `loadWorkspace` counts `pre/` changesets as pending** (so `check` judges them and `prepare`
   versions and cross-checks from them), and `verifyRelease` requires each `.changeset/pre/*.md` deleted, computing the
   version from all of them with the existing `impliedVersion`. `check`'s reused-name rule now holds in both modes.
3. **The release notes carry every changeset since the last plain release, `pre/` ones included.** The notes tool
   reads what Changesets would consume (pre mode or not, as `pre.json` says, in the working tree or at `--at`), so
   `docs/releases/v0.2.0.md` is the whole series of candidates, and `--since v0.2.0-rc.2 --at v0.2.0^` what is new since
   the last one. Rejected: a pointer to the candidates' notes, which a new adopter reading 0.2.0 on npm would have to
   chase across three prereleases. What an adopter on a candidate does to move up is the sibling task's "Upgrading to
   this release" section, not built here.
4. **Tests against the real CLI**: `tests/tooling/release-pre-mode.test.ts` cuts rc.0 and rc.1 of a fixture, leaves pre
   mode as the PR does, and runs `check`, the notes, `prepare` (to 0.2.0), `verify-release`, `publishable`, the notes
   regenerated `--at`, and the next plain release (0.2.1); it refuses a release that keeps a `pre/` changeset, a public
   group in pre mode, and `exit` mode; a patch and a minor both plan 0.2.0 and a major is refused. A second test releases
   a copy of this repository's own tree and requires a candidate group to release its own version.
5. **A plain release's install proof** is pack and consume's registry step (pages shape): the packed tarballs served
   as an npm registry for the `@sssb` scope, installed at the spec the generator writes.
