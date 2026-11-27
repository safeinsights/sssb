import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '@sssb/tools/testing/tmp-dir'
import { createFakeStorage, fakeStorage } from '@sssb/kit/adapters/fake/storage'
import type { PostUploadTarget, UploadTarget } from '@sssb/kit/ports/storage'
import { POST, PUT } from './route'

// Point fake-adapter state at a throwaway dir BEFORE any storage call (the HMAC secret + the bytes
// both live under it). The route reads `storage` + `isSimulated` from @/adapters — we mock that module
// (vi.mock is hoisted above the imports) to the REAL fake storage singleton, so signatures verify
// against the same secret, with a toggleable isSimulated; verifyUploadFields (imported directly by the
// route from @/adapters/fake/storage) stays real.
const tmp = makeTestTmpDir('app-upload-')
const adaptersState = vi.hoisted(() => ({ fake: true }))
vi.mock('@sssb/kit/adapters/index', async () => {
    const actual = await import('@sssb/kit/adapters/fake/storage')
    return {
        get isSimulated() {
            return adaptersState.fake
        },
        storage: actual.fakeStorage,
    }
})

beforeAll(() => {
    process.env.APP_DATA_DIR = tmp
})
afterAll(() => {
    delete process.env.APP_DATA_DIR
})
beforeEach(() => {
    adaptersState.fake = true
})

/** A POST target's fields, failing the test if the fake minted a PUT. */
function fieldsOf(target: UploadTarget): PostUploadTarget['fields'] {
    if (target.method === 'PUT') throw new Error('expected a POST upload target')
    return target.fields
}

function makeRequest(fields: Record<string, string>, file?: File): Request {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    if (file) form.append('file', file)
    return new Request('http://localhost/api/storage-upload', { method: 'POST', body: form })
}

const KEY = 'attachments/tenant-northwind/uuid-abc/hello.txt'

describe('POST /api/storage-upload (fake presigned-POST twin)', () => {
    test('204 accepts a valid signed multipart POST and stores the bytes', async () => {
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const file = new File([new TextEncoder().encode('hello world')], 'hello.txt', { type: 'text/plain' })

        const response = await POST(makeRequest(fieldsOf(target), file))
        expect(response.status).toBe(204)

        const stored = await fakeStorage.get(KEY)
        expect(stored).not.toBeNull()
        expect(new TextDecoder().decode(stored!.body)).toBe('hello world')
        expect(stored!.contentType).toBe('text/plain')
    })

    test('403 on a tampered signature (S3 SignatureDoesNotMatch)', async () => {
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const file = new File([new Uint8Array([1, 2, 3])], 'hello.txt', { type: 'text/plain' })
        const response = await POST(makeRequest({ ...fieldsOf(target), signature: 'forged' }, file))
        expect(response.status).toBe(403)
    })

    test('403 when the file type differs from the signed content-type (S3 eq $Content-Type)', async () => {
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const file = new File([new Uint8Array([1, 2, 3])], 'hello.txt', { type: 'text/html' })
        const response = await POST(makeRequest(fieldsOf(target), file))
        expect(response.status).toBe(403)
    })

    test('400 when the file exceeds the signed size ceiling (S3 EntityTooLarge)', async () => {
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 3 })
        const file = new File([new TextEncoder().encode('way too many bytes')], 'hello.txt', { type: 'text/plain' })
        const response = await POST(makeRequest(fieldsOf(target), file))
        expect(response.status).toBe(400)
    })

    test('400 when the file part is missing', async () => {
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const response = await POST(makeRequest(fieldsOf(target)))
        expect(response.status).toBe(400)
    })

    test('404 outside simulated mode (real uploads go straight to S3)', async () => {
        adaptersState.fake = false
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const file = new File([new Uint8Array([1])], 'hello.txt', { type: 'text/plain' })
        const response = await POST(makeRequest(fieldsOf(target), file))
        expect(response.status).toBe(404)
    })
})

/**
 * A PUT as the route sees it. A `Request` built in-process has no Content-Length (fetch adds it on the wire, and the
 * server runtime hands the handler the header), so the headers are given explicitly: the route reads them as given.
 */
function requestWith(url: URL, headers: Headers, body: Uint8Array): Request {
    const request = new Request(url, { method: 'PUT', body: new Blob([body as BlobPart]) })
    Object.defineProperty(request, 'headers', { value: headers })
    return request
}

describe('PUT /api/storage-upload (fake presigned-PUT twin)', () => {
    const putStorage = createFakeStorage({ uploadTarget: 'put' })
    const BODY = new TextEncoder().encode('hello world')

    /** A PUT as the browser sends it: the target's URL and headers, the file as the body (it adds Content-Length). */
    async function send(
        options: {
            size?: number
            body?: Uint8Array
            mutateUrl?: (url: URL) => void
            headers?: Record<string, string | null>
        } = {},
    ): Promise<Response> {
        const target = await putStorage.createUploadTarget(KEY, {
            contentType: 'text/plain',
            maxBytes: 1000,
            sizeBytes: options.size ?? BODY.byteLength,
        })
        if (target.method !== 'PUT') throw new Error('expected a PUT upload target')
        const url = new URL(target.url, 'http://localhost')
        options.mutateUrl?.(url)
        const body = options.body ?? BODY
        const headers = new Headers({ ...target.headers, 'content-length': String(body.byteLength) })
        for (const [name, value] of Object.entries(options.headers ?? {})) {
            if (value === null) headers.delete(name)
            else headers.set(name, value)
        }
        return PUT(requestWith(url, headers, body))
    }

    test('200 accepts a valid signed PUT and stores the bytes with the signed content type', async () => {
        await fakeStorage.delete([KEY])
        const response = await send()
        expect(response.status).toBe(200)
        const stored = await fakeStorage.get(KEY)
        expect(new TextDecoder().decode(stored!.body)).toBe('hello world')
        expect(stored!.contentType).toBe('text/plain')
    })

    test('403 on a tampered signature, and on a tampered key, size or ceiling', async () => {
        for (const [name, value] of [
            ['signature', 'forged'],
            ['key', 'attachments/tenant-other/uuid/evil.txt'],
            ['size', '5'],
            ['max-bytes', '999999'],
        ] as const) {
            const response = await send({ mutateUrl: (url) => url.searchParams.set(name, value) })
            expect(response.status, name).toBe(403)
        }
    })

    test('403 on a POST target replayed as a PUT (no size, no PUT signature)', async () => {
        const post = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const url = new URL('/api/storage-upload', 'http://localhost')
        for (const [name, value] of Object.entries(fieldsOf(post))) url.searchParams.set(name, value)
        const response = await PUT(
            requestWith(url, new Headers({ 'content-type': 'text/plain', 'content-length': '11' }), BODY),
        )
        expect(response.status).toBe(403)
    })

    test('403 when Content-Type differs from the signed one, or is missing', async () => {
        expect((await send({ headers: { 'content-type': 'text/html' } })).status).toBe(403)
        expect((await send({ headers: { 'content-type': null } })).status).toBe(403)
    })

    test('403 when the body is not the signed size (a signed Content-Length that differs), over or under', async () => {
        expect((await send({ size: 5 })).status).toBe(403)
        expect((await send({ size: 20 })).status).toBe(403)
    })

    test('411 without a Content-Length', async () => {
        const target = await putStorage.createUploadTarget(KEY, {
            contentType: 'text/plain',
            maxBytes: 1000,
            sizeBytes: 11,
        })
        if (target.method !== 'PUT') throw new Error('expected a PUT upload target')
        // No Content-Length: the form of a chunked upload, which a real S3 refuses with 411 as well.
        const request = requestWith(new URL(target.url, 'http://localhost'), new Headers(target.headers), BODY)
        expect((await PUT(request)).status).toBe(411)
    })

    test('400 when the body is not as long as the length it declared (and signed)', async () => {
        // The declared length is the signed one, but fewer bytes arrive: a truncated upload is never stored.
        await fakeStorage.delete([KEY])
        const response = await send({ size: 20, body: BODY, headers: { 'content-length': '20' } })
        expect(response.status).toBe(400)
        expect(await fakeStorage.get(KEY)).toBeNull()
    })

    test('404 outside simulated mode (real uploads go straight to S3)', async () => {
        adaptersState.fake = false
        const target = await fakeStorage.createUploadTarget(KEY, { contentType: 'text/plain', maxBytes: 1000 })
        const file = new File([new Uint8Array([1])], 'hello.txt', { type: 'text/plain' })
        const response = await POST(makeRequest(fieldsOf(target), file))
        expect(response.status).toBe(404)
    })
})
