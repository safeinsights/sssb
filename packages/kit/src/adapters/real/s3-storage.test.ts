import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createS3Storage } from './s3-storage'

/**
 * The published S3 adapter's options (`@sssb/kit/adapters/real/s3-storage`). No network: a presigned download URL is
 * built locally and shows the endpoint, the addressing style, the region and the credential the client was made with.
 * Its methods' behaviour is proven in ./storage.test.ts, through the registry's `createRealStorage`, which is this
 * same adapter on a bucket and a region.
 */
const credentials = { accessKeyId: 'AKIAEXAMPLEDEVEDGE', secretAccessKey: 'not-a-real-secret' }

afterEach(() => {
    vi.restoreAllMocks()
})

describe('createS3Storage', () => {
    test('reaches an S3-compatible endpoint by path, with the credentials and region it is given', async () => {
        const storage = createS3Storage({
            bucket: 'sandbox-edge',
            region: 'us-west-2',
            endpoint: 'http://minio.example.test:9000',
            credentials,
            forcePathStyle: true,
        })
        const url = new URL(await storage.getSignedDownloadUrl('pages/a b.html', 60))
        expect(url.origin).toBe('http://minio.example.test:9000')
        expect(url.pathname).toBe('/sandbox-edge/pages/a%20b.html')
        expect(url.searchParams.get('X-Amz-Credential')).toMatch(
            /^AKIAEXAMPLEDEVEDGE\/\d{8}\/us-west-2\/s3\/aws4_request$/,
        )
        expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
        expect(url.searchParams.get('response-content-disposition')).toBe('attachment')
    })

    test('addresses the bucket by host on AWS unless path style is asked for', async () => {
        const storage = createS3Storage({ bucket: 'sandbox-edge', region: 'us-west-2', credentials })
        const url = new URL(await storage.getSignedDownloadUrl('k'))
        expect(url.hostname).toBe('sandbox-edge.s3.us-west-2.amazonaws.com')
        expect(url.pathname).toBe('/k')

        // A named endpoint too: without `forcePathStyle` the bucket stays in the host (an IP endpoint is always by path).
        const named = createS3Storage({
            bucket: 'sandbox-edge',
            region: 'us-west-2',
            endpoint: 'http://minio.example.test:9000',
            credentials,
        })
        const byHost = new URL(await named.getSignedDownloadUrl('k'))
        expect(byHost.hostname).toBe('sandbox-edge.minio.example.test')
        expect(byHost.pathname).toBe('/k')
    })

    test('a credentials provider is called for the credentials, as the SDK calls one', async () => {
        const provider = vi.fn(async () => credentials)
        const storage = createS3Storage({ bucket: 'b', region: 'us-east-1', credentials: provider })
        const url = new URL(await storage.getSignedDownloadUrl('k'))
        expect(provider).toHaveBeenCalled()
        expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAEXAMPLEDEVEDGE\//)
    })

    test('uses a client it is given, as it is', async () => {
        const client = new S3Client({ region: 'us-east-1', credentials })
        const send = vi.spyOn(client, 'send').mockResolvedValue({} as never)
        await createS3Storage({ bucket: 'b', client }).put('k', new Uint8Array([1]), 'text/plain')
        expect(send).toHaveBeenCalledTimes(1)
        const command = send.mock.calls[0]?.[0]
        expect(command).toBeInstanceOf(PutObjectCommand)
        expect((command as PutObjectCommand).input).toMatchObject({ Bucket: 'b', Key: 'k', ContentType: 'text/plain' })
    })

    test('uploadTarget `put` builds its own client without the default checksum, and a given client that adds one is refused', async () => {
        const own = createS3Storage({ bucket: 'b', region: 'us-east-1', credentials, uploadTarget: 'put' })
        const target = await own.createUploadTarget('k', { contentType: 'text/plain', maxBytes: 10, sizeBytes: 3 })
        expect(target).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'text/plain' } })
        expect(new URL(target.url).searchParams.has('x-amz-checksum-crc32')).toBe(false)

        // A client the caller built with the SDK's own default signs an empty body's checksum into the URL.
        const given = new S3Client({ region: 'us-east-1', credentials })
        await expect(
            createS3Storage({ bucket: 'b', client: given, uploadTarget: 'put' }).createUploadTarget('k', {
                contentType: 'text/plain',
                maxBytes: 10,
                sizeBytes: 3,
            }),
        ).rejects.toThrow(/carries x-amz-checksum-crc32.*requestChecksumCalculation: 'WHEN_REQUIRED'/)

        // And one built for it works, uploadTarget not counting as a client option that would be ignored.
        const fitted = new S3Client({ region: 'us-east-1', credentials, requestChecksumCalculation: 'WHEN_REQUIRED' })
        const ok = await createS3Storage({ bucket: 'b', client: fitted, uploadTarget: 'put' }).createUploadTarget('k', {
            contentType: 'text/plain',
            maxBytes: 10,
            sizeBytes: 3,
        })
        expect(ok.method).toBe('PUT')
    })

    test('the default form is a POST, and says so', async () => {
        const target = await createS3Storage({ bucket: 'b', region: 'us-east-1', credentials }).createUploadTarget(
            'k',
            {
                contentType: 'text/plain',
                maxBytes: 10,
            },
        )
        expect(target.method).toBe('POST')
        expect(target).toHaveProperty('fields')
    })

    test('refuses client options beside a client, which would be ignored, and a missing bucket', () => {
        const client = new S3Client({ region: 'us-east-1' })
        expect(() => createS3Storage({ bucket: 'b', client, endpoint: 'http://127.0.0.1:9000' })).toThrow(
            /a client was given, so endpoint would be ignored/,
        )
        expect(() => createS3Storage({ bucket: 'b', client, region: 'eu-west-1', forcePathStyle: true })).toThrow(
            /region, forcePathStyle would be ignored/,
        )
        expect(() => createS3Storage({ bucket: '' })).toThrow(/bucket is required/)
    })
})
