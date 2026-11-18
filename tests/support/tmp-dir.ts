// The scratch-directory helper, for this repository's own tests: @sssb/tools' (ADR-0014 P4), the one any workspace
// package imports. The framework's own tests use the copy inside packages/kit instead (packages/kit/src/testing),
// because @sssb/kit depends on no other SSSB package; both write the same marker, so `sssb check-tmpdir-leak` sees
// either one's leaks (tests/tooling/tmp-dir.test.ts holds the two equal). Only what this repository's tests import is
// re-exported (knip); `makeTestTmpDirAsync` is @sssb/tools' too.
export { makeTestTmpDir } from '@sssb/tools/testing/tmp-dir'
