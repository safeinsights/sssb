---
'@sssb/kit': patch
'@sssb/tools': patch
'@sssb/eslint-plugin': patch
'@sssb/cdk': patch
'@sssb/create': patch
---

### SSSB's packages are on npm, and a release is a plain version

**Kind.** scaffold

**Action.** optional

**What changed.** `@sssb/kit`, `@sssb/tools`, `@sssb/eslint-plugin`, `@sssb/cdk` and `@sssb/create` are public, and
SSSB's release flow publishes them to npm with provenance at one version. Release candidates (`-rc.N` tarballs on a
GitHub prerelease) end here: this release's notes carry every change since the first candidate, and later releases are
plain `0.x.y` versions on npm only. `pnpm create @sssb` now fetches the generator from npm, and the workspace it writes
depends on each package at `^` its version.

**To adopt.** In each workspace package that depends on an `@sssb/*` package by a release-candidate tarball URL (or a
`file:` path), replace the URL with the version, and drop any `overrides` you kept for them:

```json
{
    "@sssb/kit": "^0.2.0",
    "@sssb/tools": "^0.2.0"
}
```

Then `pnpm install`, commit the lockfile, and run `pnpm exec sssb doctor`: it reports a workflow or plugin marketplace
pin that is not this release's commit, and you move each pin it names. Staying on a candidate's tarballs keeps working,
but no later release ships as tarballs.

**Now deletable.** Tarball URLs copied from a prerelease's notes, the `sha512` checks made against them, and any
`overrides` or `file:` paths that pointed `@sssb/*` at a downloaded tarball.
