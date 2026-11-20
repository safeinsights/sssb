import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TMP_DIR_MARKER_SUFFIX as TOOLS_SUFFIX } from '../../packages/tools/src/testing/tmp-dir-marker.js'

/**
 * @sssb/kit keeps its own copy of the scratch-directory helper for its shipped tests, because the framework
 * depends on no other SSSB package (ADR-0014, rule 4). `sssb check-tmpdir-leak` only sees a leak whose marker file ends in ITS
 * suffix, so if the two copies ever drifted apart the wrapper would report a clean run while the framework's tests
 * leaked. This holds the two spellings equal. The kit's copy is an internal of the package, which nothing outside it
 * imports by path (sssb/no-path-into-kit), so its one line is read as text.
 */
const KIT_MARKER = new URL('../../packages/kit/src/testing/tmp-dir-marker.mjs', import.meta.url)
const declared = /^export const TMP_DIR_MARKER_SUFFIX = '([^']+)'$/m.exec(readFileSync(KIT_MARKER, 'utf8'))

describe('the scratch-directory marker suffix', () => {
    it('is the same in @sssb/tools and in @sssb/kit', () => {
        expect(declared, 'the kit declares TMP_DIR_MARKER_SUFFIX as one string literal').not.toBeNull()
        expect(declared?.[1]).toBe(TOOLS_SUFFIX)
        expect(TOOLS_SUFFIX).toMatch(/^\.\S+$/)
    })
})
