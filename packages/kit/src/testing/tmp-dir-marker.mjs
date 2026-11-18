// The suffix of the empty sibling file that tmp-dir.ts (beside it) drops next to every scratch
// directory it creates (`<dir>` + this suffix). The leak guard (`sssb check-tmpdir-leak`, @sssb/tools) reads
// @sssb/tools' own copy of this constant, since no SSSB package depends on another; tests/tooling/tmp-dir.test.ts
// holds the two spellings equal. Plain .mjs, so it needs no TypeScript loader.
export const TMP_DIR_MARKER_SUFFIX = '.sssb-test-tmp'
