// @ts-check
// The suffix of the empty sibling file that tmp-dir.js (beside it) drops next to every scratch directory it
// creates (`<dir>` + this suffix). Its own module so the leak wrapper (`sssb check-tmpdir-leak`) reads the same
// constant the helper writes with, without loading the helper, which imports vitest.
//
// @sssb/kit keeps a copy of the helper for its own shipped tests (packages/kit/src/testing), because no SSSB
// package depends on another (ADR-0014, rule 4). Its marker suffix must be this one, or the wrapper would not see
// the framework's leaks; tests/tooling/tmp-dir.test.ts holds the two equal.
export const TMP_DIR_MARKER_SUFFIX = '.sssb-test-tmp'
