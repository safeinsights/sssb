import { afterEach, describe, expect, test, vi } from 'vitest'
import { sendToUploadTarget } from './send-to-upload-target'

const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
vi.stubGlobal('fetch', fetchMock)
afterEach(() => fetchMock.mockClear())

const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

describe('sendToUploadTarget', () => {
    test('a POST target gets multipart: its fields first, then the file', async () => {
        await sendToUploadTarget({ url: '/up', fields: { key: 'k', policy: 'p' } }, file)
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('/up')
        expect(init.method).toBe('POST')
        const form = init.body as FormData
        expect([...form.keys()]).toEqual(['key', 'policy', 'file'])
        expect(form.get('file')).toBeInstanceOf(File)
    })

    test('a target that names its method POST is the same', async () => {
        await sendToUploadTarget({ method: 'POST', url: '/up', fields: { key: 'k' } }, file)
        expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST')
    })

    test('a PUT target gets the file as the body, with exactly its headers and no form', async () => {
        await sendToUploadTarget(
            { method: 'PUT', url: 'https://store/up?sig=1', headers: { 'Content-Type': 'text/plain' } },
            file,
        )
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('https://store/up?sig=1')
        expect(init.method).toBe('PUT')
        expect(init.headers).toEqual({ 'Content-Type': 'text/plain' })
        expect(init.body).toBe(file)
    })
})
