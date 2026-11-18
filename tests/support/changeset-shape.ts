// The shape lint is `scripts/release-notes.mjs`'s own, so the changesets the tests check are read by the code that
// assembles the release notes from them (and that `release.mjs check` and `prepare` run): one parser, not two.
export { lintChangeset } from '../../scripts/release-notes.mjs'
