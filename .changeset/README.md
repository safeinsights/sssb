# Changesets

SSSB's packages are released with [Changesets](https://github.com/changesets/changesets) (ADR-0014 part 10).
A changeset is a markdown file here naming the packages a change affects and how far it bumps them, for example
`.changeset/short-name.md`:

```md
---
'@sssb/kit': minor
---

What changed, for the changelog.
```

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
