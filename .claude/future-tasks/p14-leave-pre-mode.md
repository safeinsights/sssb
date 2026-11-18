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
