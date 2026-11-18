import { describe, expect, it } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX as FRAMEWORK_SUFFIX } from '../../packages/kit/src/testing/tmp-dir-marker.mjs'
import { TMP_DIR_MARKER_SUFFIX as TOOLS_SUFFIX } from '../../packages/tools/src/testing/tmp-dir-marker.js'

/**
 * @sssb/kit keeps its own copy of the scratch-directory helper for its shipped tests, because no SSSB package
 * depends on another (ADR-0014, rule 4). `sssb check-tmpdir-leak` only sees a leak whose marker file ends in ITS
 * suffix, so if the two copies ever drifted apart the wrapper would report a clean run while the framework's tests
 * leaked. This holds the two spellings equal.
 */
describe('the scratch-directory marker suffix', () => {
    it('is the same in @sssb/tools and in @sssb/kit', () => {
        expect(FRAMEWORK_SUFFIX).toBe(TOOLS_SUFFIX)
        expect(TOOLS_SUFFIX).toMatch(/^\.\S+$/)
    })
})
