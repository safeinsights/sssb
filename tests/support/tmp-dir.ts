// The scratch-directory helper lives in the framework's package now (ADR-0014 P3), so that none of
// @sssb/kit's own tests reaches outside packages/kit for it. The repo's own tests and the apps' tests
// keep importing it from here until P4 moves it into @sssb/tools; this re-export is the same module, so
// a test file still gets one cleanup hook, not two.
export { makeTestTmpDir, makeTestTmpDirAsync } from '../../packages/kit/src/testing/tmp-dir'
