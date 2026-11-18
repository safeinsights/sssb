# Changesets

SSSB's packages are released with [Changesets](https://github.com/changesets/changesets) (ADR-0014 part 10).
A changeset is a markdown file here, and it is also the release-note entry for its change. ADR-0014 P7's release
notes have four sections ("Seam changes", "Framework migrations", "Operator actions", "Scaffold changes to apply by
hand"); each changeset says which one it belongs to and what an adopter does, so the notes can be written from them.
The shape follows CanopyCMS's changelog, whose entries end with "Now deletable"; its assembly script is not copied. Name the file after the change, in kebab-case: `.changeset/short-name.md`.

## When one is required

CI's `changeset-required` job fails a PR that changes what ships to adopters and adds no changeset. What ships is
`packages/kit/package.json`, the files `@sssb/kit`'s `files` allowlist ships (`packages/kit/src`, less tests and
stories, plus the five seam-conformance tests), and `apps/starter`. Not `apps/showcase`, `packages/seed`, the
kit's `test-fixture`, tests, scripts, docs, infra or the lockfile. Dependabot's PRs and the release merge from
`integration` are exempt; so is a PR opened before the gate reached its base branch. The rule and its cases are
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

**What changed.** One or two sentences.

**To adopt.** What the adopter does, with the import path and the call shape.

**Now deletable.** The PATTERN of local code this supersedes ("a hand-rolled wrapper around X"), recognisable in any
adopter's tree.
```

- **Kind** is one of `seam` (the `@sssb/app-config/*` contract or a public subpath changed), `migration` (a
  framework migration an app must take or order around), `operator` (something the deployer does: params, secrets,
  infra), `scaffold` (the starter changed and an adopter applies it by hand), or `none` (a fix adopters need not act
  on). They are P7's four sections, in that order.
- **To adopt** is required for every kind but `none`; **Now deletable** is left out when nothing becomes deletable.
- **A kind that asks the adopter to act is a `minor`**, since a patch must be compatible; `none` may be a `patch`.
  Never `major` (next section).
- The title is `###`, so entries nest under the release notes' headings. Describe the change an adopter sees, not
  the PR; never name another adopter's files or hosts.

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
