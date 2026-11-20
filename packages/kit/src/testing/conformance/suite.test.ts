import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../tmp-dir'
import { appDirMismatch } from './suite'

/**
 * `conformanceSuite({ appDir })` is held to the app whose suite file calls it: a suite file in app A pointed at app B
 * would run every file-reading check over B's files and pass A. The app is the nearest directory at or above the test
 * file that holds a package.json.
 */

function twoApps() {
    const root = makeTestTmpDir('conformance-appdir-')
    for (const app of ['alpha', 'beta']) {
        mkdirSync(path.join(root, app, 'src'), { recursive: true })
        writeFileSync(path.join(root, app, 'package.json'), '{}')
    }
    const suiteFile = path.join(root, 'alpha', 'src', 'sssb.conformance.test.ts')
    return { root, suiteFile }
}

describe('appDirMismatch', () => {
    it("passes the calling file's own app, however the path is spelled", () => {
        const { root, suiteFile } = twoApps()
        expect(appDirMismatch(path.join(root, 'alpha'), suiteFile)).toBeNull()
        expect(appDirMismatch(path.join(root, 'alpha', 'src', '..'), suiteFile)).toBeNull()
        symlinkSync(path.join(root, 'alpha'), path.join(root, 'alpha-link'))
        expect(appDirMismatch(path.join(root, 'alpha-link'), suiteFile)).toBeNull()
    })

    it("refuses another app's directory, naming both", () => {
        const { root, suiteFile } = twoApps()
        const message = appDirMismatch(path.join(root, 'beta'), suiteFile)
        expect(message).toContain(path.join(root, 'beta'))
        expect(message).toContain(path.join(root, 'alpha'))
    })

    it('refuses a directory above the app, and one that does not exist', () => {
        const { root, suiteFile } = twoApps()
        expect(appDirMismatch(root, suiteFile)).not.toBeNull()
        expect(appDirMismatch(path.join(root, 'gamma'), suiteFile)).not.toBeNull()
    })
})
