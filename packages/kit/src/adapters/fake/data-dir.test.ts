// @vitest-environment node
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'
import { dataRoot, setDataRoot } from './data-dir'

let previous: string | undefined
afterEach(() => {
    setDataRoot(previous)
})

test('a relative APP_DATA_DIR is read against the working directory, and fake storage works under it', async () => {
    const tmp = makeTestTmpDir('app-data-dir-relative-')
    previous = setDataRoot(path.relative(process.cwd(), tmp))
    expect(dataRoot()).toBe(path.resolve(tmp))
    const { fakeStorage } = await import('./storage')
    await fakeStorage.put('a/b.txt', 'x', 'text/plain')
    const got = await fakeStorage.get('a/b.txt')
    expect(got).not.toBeNull()
})
