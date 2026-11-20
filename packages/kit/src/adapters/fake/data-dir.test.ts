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

test('the data root is a normalised absolute path, however APP_DATA_DIR is written', () => {
    previous = setDataRoot('./zz-a/../zz-b/./c/')
    expect(dataRoot()).toBe(path.resolve('zz-b/c'))
    setDataRoot(path.join(process.cwd(), 'zz-d', '..', 'zz-e'))
    expect(dataRoot()).toBe(path.resolve('zz-e'))
    setDataRoot(`${path.sep}..${path.sep}..`)
    expect(dataRoot()).toBe(path.resolve(path.sep))
    setDataRoot(path.join(process.cwd(), 'zz-a\\b'))
    expect(dataRoot()).toBe(path.resolve('zz-a\\b'))
    setDataRoot(undefined)
    expect(dataRoot()).toBe(path.resolve('.data'))
})
