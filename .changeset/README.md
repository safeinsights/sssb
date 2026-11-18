# Changesets

SSSB's packages are released with [Changesets](https://github.com/changesets/changesets) (ADR-0014 part 10).
A changeset is a markdown file here, and it is also the release-note entry for its change. ADR-0014 P7's release
notes have four sections ("Seam changes", "Framework migrations", "Operator actions", "Scaffold changes to apply by
hand"); each changeset says which one it belongs to and what an adopter does, and `scripts/release-notes.mjs`
assembles the notes from them (below).
The shape follows CanopyCMS's changelog, whose entries end with "Now deletable"; its assembly script is not copied. Name the file after the change, in kebab-case: `.changeset/short-name.md`.

## When one is required

CI's `changeset-required` job fails a PR that changes what ships to adopters and adds no changeset. What ships:

- **Every `@sssb/*` package under `packages/`** (read from its `package.json`, so a package added later is covered
  the day it lands), less tests, stories and a `test-fixture` directory. For `packages/kit` that is exactly what its
  `files` allowlist ships: `package.json`, `src` less tests and stories, and `dist`, built when the package is packed by `packages/kit/scripts/`, which the gate counts in its place.
- **`apps/starter`**, the scaffold an adopter keeps and edits, which becomes `@sssb/create`'s template (ADR-0014 P12).
- **`plugins/` and `.claude-plugin/`**, the Claude Code plugin and its marketplace (ADR-0014 P13), which an adopter's
  Claude Code loads from this repository at the commit their `.claude/settings.json` pins. Name `@sssb/create` in
  the changeset: the plugin is no npm package, and the generator is what writes that pin.

Not gated: `apps/showcase`, `packages/seed` (the showcase's world, `@app/seed`), tests, scripts, docs and the
lockfile. **Known gaps:** while adoption is still a fork that takes updates by merge (ADR-0013), a forking adopter
receives those too, and also `docs/cutover-checklist.md`, the ESLint config, `.gitleaks.toml` and the CI workflows;
a change to any of them is not gated. Write a changeset for it anyway when it is an "Operator actions" or "Scaffold
changes" item. Each app's deployment is in the app since ADR-0014's P9, so `apps/starter/infra/` is gated with the
starter and `packages/cdk` as a package, while `apps/showcase/infra/` is not. ADR-0014's later steps move more of
these into packages and the starter, which the gate covers, and some elsewhere (a generator's write-once files);
until each step lands, check whether the gate sees your change.

Exempt: a PR from `integration` into `main` in this repository (the release merge); Dependabot's PRs, unless one
changes the kit's `peerDependencies` (a raised peer floor is breaking); a PR opened before the gate reached its base
branch; and a file a PR carries only because it merged `main` in. The rule and its cases are
`.github/scripts/require-changeset.sh` and `tests/tooling/changesets.test.ts`.

If adopters would see no difference (a refactor, an internal fix), add an **empty changeset**: a file holding only
`---` and `---`. `pnpm changeset add --empty` writes one once the packages are public; until then write it by hand.

## Template

Copy it; `tests/tooling/changesets.test.ts` checks every file here against it.

```md
---
'@sssb/kit': minor
---

### Short title

**Kind.** seam

**Action.** required

**What changed.** One or two sentences.

**To adopt.** What the adopter does, with the import path and the call shape.

**Now deletable.** The PATTERN of local code this supersedes ("a hand-rolled wrapper around X"), recognisable in any
adopter's tree.
```

- **Kind** says which release-note section the entry belongs to, one value per file (a change that belongs to two
  sections is two files). `seam`: what an app must say or satisfy to build, i.e. the `@sssb/app-config/*` contract, an
  `exports` removal or addition, a raised peer floor, a lint rule, conformance check, `sssb doctor` check or tsconfig
  option that newly fails app code. `migration`: a framework migration an app must take or order around. `operator`:
  something the deployer does, i.e. params, a required environment variable, secret or IAM permission, a stateful
  resource replaced. `scaffold`: the starter changed and an adopter applies it by hand. `none`: a fix with no
  section. They are P7's four sections, in that order.
- **Action** says whether the adopter must do something, and it, not Kind, sets the bump: `required` (an adopter who
  does nothing breaks) is a `minor`, ADR-0014 part 10's "breaking"; `optional` (new and additive) and `none` may be a
  `patch`. Kind `none` has Action `none`. Never `major` (next section).
- **To adopt** is required unless Action is `none`; **Now deletable** is left out when nothing becomes deletable.
- Describe the change an adopter sees, not the PR; never name another adopter's files or hosts. Code in a fenced
  block is not read for structure, so `# comments` in a shell snippet are fine.
- **A name is never reused, and a file is edited after a release candidate only to correct it.** More to say about a
  change a release candidate already carried is a new file. A release candidate's notes are the changesets added
  since the previous candidate's tag.
- **The release notes are assembled from these files, not by Changesets.** `changeset version` groups the bodies by
  bump under "Major", "Minor" and "Patch Changes" (`@changesets/apply-release-plan`), ignores Kind and Action, and
  deletes the files. `scripts/release-notes.mjs` reads them first and writes the notes an adopter reads (below).

`.github/workflows/release.yml` versions the pending ones on the next push to `main` and publishes the result.
`pnpm changeset` writes one once the packages are public; until then it stops at "No versionable packages found",
so write the file by hand. This README is not a changeset; Changesets skips it, and `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md` and dotfiles too.

- **One version for the set.** Every `@sssb/*` workspace package is in one fixed group (`config.json`), so a
  changeset for one of them releases all of them at the same version. Name only those packages: CI refuses a
  changeset that names an app or any other package, because Changesets would never consume it and every later
  release would stop on it.
- **On 0.x a breaking change is a `minor`, never a `major`.** `^0.3.0` accepts only `0.3.x`, so a minor is the
  breaking channel and a patch must be compatible. Changesets turns a `major` on 0.x into 1.0.0, and npm versions
  cannot be withdrawn, so CI's `release-plan` job fails on a `major` changeset and on any plan that reaches 1.0.0
  (`pnpm release:check`). ADR-0014 part 10 lists what counts as breaking.
- **Nothing is published before ADR-0014's P14.** Every package is `"private": true` until then, and
  `config.json` sets `privatePackages.version` to false, so Changesets plans no release for them: a changeset
  written now stays here, and the first release takes it. `pnpm release:check` judges the plan as it will be once
  the packages are public, which is the only plan that can reach npm.
- **Prereleases are not Changesets' pre mode.** Release candidates are tarballs on a GitHub prerelease (ADR-0014
  P7), and `scripts/release.mjs` refuses a `pre.json` here.
- `format` is `prettier`: Changesets formats the changelogs a release writes with the repository's own Prettier,
  which `pnpm lint` checks.

## Release notes

```sh
pnpm release:notes                                  # every pending changeset, to stdout
pnpm release:notes --version 0.2.0 --out notes.md   # with the version in the heading, to a file
pnpm release:notes --since v0.1.0-rc.1              # what was added since a tag, from git: a release candidate's notes
pnpm release:notes --at v0.2.0^ --version 0.2.0     # a finished release's notes, from before its release commit
pnpm release:notes --check                          # just judge the shape, as `pnpm release:check` does
```

The notes have the four sections of ADR-0014 part 10 in its order (Seam changes, Framework migrations, Operator
actions, Scaffold changes to apply by hand), always present and `None.` when empty, then Other changes when there is
one. Inside a section the entries an adopter must act on come first (Action required, then optional, then none), then
by file name. Each entry is its title, a line saying the action and the packages, and the body as written less Kind and
Action: What changed, To adopt, Now deletable. An empty changeset is counted in the opening line and not listed. There
are no dates, so the same changesets give the same bytes.

`--since <ref>` puts the range in the heading and lists the changesets ADDED since the ref. One EDITED since (allowed
only to correct it) comes back under "Corrections to earlier notes", so an adopter who followed the earlier text is
told. `--since` and `--at` read git, not the working tree, so a changeset not yet committed is not in them.

A changeset that is not a readable entry stops the command with its file and what is wrong, and `pnpm release:check`
(CI's `release-plan` job) says the same on every PR. The frontmatter is read one quoted `'@sssb/<package>': bump` per
line, with `#` comments and a quoted bump allowed, as Changesets reads it; a fenced code block in the body is never
read for structure, and one left open is refused.

`release.yml`'s `plan` job runs `release.mjs prepare`, which assembles the notes from the pending changesets before
`changeset version` consumes them and writes them to `docs/releases/v<version>.md`: a new file in the release commit,
which `verify-release` accepts at exactly that path. The job also appends them to its run summary.

## Release candidates, until P14

While the packages are private, every release is a release candidate (ADR-0014 P7): `pre.json` holds Changesets' pre
mode with the tag `rc`, and `config.json` versions private packages and ignores every package outside `@sssb/*`
(`"*"` and `"@app/*"`), so a merge to `main` that carries changesets cuts `0.x.y-rc.N`. No one decides a release
separately from the merge. In pre mode Changesets moves each changeset it consumes to `pre/` instead of deleting it;
those are kept until pre mode ends at P14 and are not pending, so the next candidate's notes hold only what is new. The
candidate's tag then attaches the tarballs CI tested to a GitHub prerelease, with these notes, the install lines and
each tarball's sha512 (`docs/runbooks/release-app.md`). `pnpm release:check` fails a PR that takes the group out of pre
mode while it is private, or into pre mode once it is public. The four `history-since-keel-*.md` changesets hold
everything since keel's `24b0589` that predates changesets, and so appear once, in the first candidate's notes.
