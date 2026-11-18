// @ts-check
// A Vitest setup file (`test.setupFiles`): registers the scratch-directory helper's cleanup hook at the top of every
// test file, before the file's own code. Vitest runs setup files before each file even with `isolate: false`, where
// the helper (./tmp-dir.js) loads only once per worker; this is what keeps its cleanup per file and last in order
// there. SSSB's Vitest preset (`@sssb/tools/vitest`) adds it to every app project; another config adds
// `'@sssb/tools/testing/tmp-dir-setup'` to its `setupFiles`.
import { registerTestTmpDirCleanup } from './tmp-dir.js'

registerTestTmpDirCleanup()
