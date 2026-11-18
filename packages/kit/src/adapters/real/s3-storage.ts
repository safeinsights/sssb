import {
    CopyObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { NotFoundError, PreconditionFailedError } from '../../ports/errors'
import type { CopyOptions, StoragePort, StoredObject, StoredObjectInfo } from '../../ports/storage'

/** S3's hard cap on keys in one DeleteObjects request. */
const DELETE_BATCH_SIZE = 1000

/**
 * `CopySource` for an object in `bucket`: `<bucket>/<key>`, with each key SEGMENT percent-encoded and the
 * slashes between them left alone (the shape AWS documents: `awsexamplebucket/reports/january.pdf`). The
 * SDK sends the string as given and AWS says "The value must be URL-encoded", so a `?` left in a key would
 * start the `?versionId=` suffix AWS documents and a `%` would start an escape; a `+` is ambiguous in URL
 * decoding, so it is encoded too. The bucket is always the adapter's own, so a key can
 * never name another bucket: `other-bucket/x` is the key `other-bucket/x` of THIS one.
 */
function copySourceFor(bucket: string, key: string): string {
    return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Where the adapter's bucket is, and how it reaches it. Only `bucket` is required: with the rest left out, the
 * S3 client finds its region and credentials the AWS SDK's own way (environment, profile, the Lambda's role).
 */
export interface S3StorageOptions {
    /** The bucket every key lives in. A key never names another bucket. */
    bucket: string
    /** The bucket's region. */
    region?: string
    /** An S3-compatible endpoint other than AWS's (a local stand-in, another provider), as a URL. */
    endpoint?: string
    /** Credentials, or a provider of them, in place of the SDK's own lookup. */
    credentials?: S3ClientConfig['credentials']
    /** Address the bucket in the path (`https://host/bucket/key`), as most S3-compatible endpoints need. */
    forcePathStyle?: boolean
    /**
     * A client the caller built, used as it is: for a client shared with other code, or one a test controls.
     * Given with any of `region`, `endpoint`, `credentials` or `forcePathStyle`, it is refused, since those would be
     * silently ignored.
     */
    client?: S3Client
}

/**
 * SSSB's storage port on a real S3 bucket (or an S3-compatible endpoint): the adapter SSSB's own registry uses in
 * real mode, published so an app that needs storage outside the registry (a simulated app run against a real
 * bucket, say) uses this one rather than a copy that drifts. The port contract is `@sssb/kit/ports/storage`'s.
 *
 * AUTHORED — CUTOVER (`cloud-accounts`; `list` and `delete` also `storage-list-delete`, `copy` also
 * `storage-copy`): typechecked, never run against a real bucket by SSSB's own tests.
 */
export function createS3Storage(options: S3StorageOptions): StoragePort {
    const { bucket, client: given, ...config } = options
    if (!bucket) throw new Error('createS3Storage: bucket is required')
    const configured = Object.entries(config).filter(([, value]) => value !== undefined)
    if (given && configured.length > 0) {
        throw new Error(
            `createS3Storage: a client was given, so ${configured.map(([name]) => name).join(', ')} would be ignored; ` +
                'configure the client instead',
        )
    }
    const client = given ?? new S3Client(Object.fromEntries(configured) as S3ClientConfig)

    return {
        async put(key, body, contentType) {
            await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
        },

        async get(key): Promise<StoredObject | null> {
            try {
                const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
                const body = await result.Body!.transformToByteArray()
                return { body, contentType: result.ContentType ?? 'application/octet-stream' }
            } catch (error) {
                if ((error as { name?: string }).name === 'NoSuchKey') return null
                throw error
            }
        },

        async head(key): Promise<StoredObjectInfo | null> {
            let result
            try {
                result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
            } catch (error) {
                // `NotFound` is the SDK's error for a HEAD 404, which has no body to say which of key and bucket
                // is missing (AWS: "It's not possible to retrieve the exact exception"), so a missing bucket reads
                // as null too. `NoSuchKey` for a stub or a future SDK that does say. A 403 (no `s3:ListBucket`)
                // and everything else are not a missing object and reach the caller as they came.
                const { name } = error as { name?: string }
                if (name === 'NotFound' || name === 'NoSuchKey') return null
                throw error
            }
            // A size of 0 or an invented date would let a caller's check pass on something S3 never said.
            const { ContentLength, ContentType, ETag, LastModified } = result
            if (ContentLength === undefined || ETag === undefined || LastModified === undefined) {
                throw new Error(`storage head: S3 answered for ${key} without a ContentLength, ETag and LastModified`)
            }
            return {
                size: ContentLength,
                contentType: ContentType ?? 'application/octet-stream',
                etag: ETag,
                lastModified: LastModified,
            }
        },

        async getSignedDownloadUrl(key, expiresInSeconds = 900): Promise<string> {
            // Force attachment disposition so user-uploaded content (whose Content-Type the uploader
            // declared) can never render inline on the bucket/CDN origin — the stored-XSS defense the
            // fake download route applies with nosniff+attachment. Keep the two paths in parity.
            return getSignedUrl(
                client,
                new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ResponseContentDisposition: 'attachment',
                }),
                { expiresIn: expiresInSeconds },
            )
        },

        async list(prefix) {
            const keys: string[] = []
            let continuationToken: string | undefined
            do {
                const page = await client.send(
                    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
                )
                for (const object of page.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key)
                continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
            } while (continuationToken)
            return keys.sort()
        },

        async delete(keys) {
            for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
                const batch = keys.slice(start, start + DELETE_BATCH_SIZE)
                // Quiet: S3 answers with failures only, so a clean batch has no `Errors` to read. A
                // missing key is not a failure (S3 reports it as deleted), which is the idempotency we promise.
                const result = await client.send(
                    new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
                    }),
                )
                const failed = result.Errors?.[0]
                if (failed) {
                    throw new Error(`storage delete failed for ${failed.Key}: ${failed.Code} ${failed.Message}`)
                }
            }
        },

        async copy(from, to, options?: CopyOptions) {
            // HTTP gives an empty If-Match no meaning and `*` the meaning "any version", so S3 could read either as
            // "no condition" and copy unchecked, where the fake would refuse. No etag `head` returns is either.
            if (options?.ifMatch !== undefined && (options.ifMatch.trim() === '' || options.ifMatch.trim() === '*')) {
                throw new Error('storage copy: ifMatch must be the etag head returned, not empty and not "*"')
            }
            // A copy onto itself changes nothing, and is nearly always two keys built the same way by mistake:
            // refuse it before spending a request, with the same error the fake gives.
            if (from === to) throw new Error(`storage copy: source and destination are the same key: ${from}`)
            try {
                // One server-side CopyObject: the bytes never leave S3. `MetadataDirective: 'COPY'` carries the
                // content type and user metadata over (naming a ContentType here would be ignored under COPY).
                // An existing `to` is overwritten, as `put` does. If S3 answers 200 with an error in the body,
                // the SDK's own middleware turns that into a thrown error, so this never reports a false success.
                await client.send(
                    new CopyObjectCommand({
                        Bucket: bucket,
                        Key: to,
                        CopySource: copySourceFor(bucket, from),
                        MetadataDirective: 'COPY',
                        // Only when asked for: S3 then copies only if the source's ETag is this one. The value
                        // is exactly what `head` returned (an opaque string, quotes and all), never rebuilt.
                        ...(options?.ifMatch !== undefined ? { CopySourceIfMatch: options.ifMatch } : {}),
                    }),
                )
            } catch (error) {
                const { name, message, $metadata } = error as {
                    name?: string
                    message?: string
                    $metadata?: { httpStatusCode?: number }
                }
                // The source is no longer the version `ifMatch` names: S3's 412. (The CopyObject reference gives
                // 412 for its other conditional headers and no code for this one, which is HTTP's rule for a
                // failed If-Match; the cutover row asks to confirm it.) Nothing was copied.
                if (name === 'PreconditionFailed' || $metadata?.httpStatusCode === 412) {
                    throw new PreconditionFailedError(
                        `storage copy: ${from} is no longer the version ${options?.ifMatch ?? '(none given)'}; nothing was copied`,
                    )
                }
                // A missing SOURCE. (A missing bucket is NoSuchBucket, a misconfiguration, and is not mapped.)
                if (name === 'NoSuchKey') throw new NotFoundError(`storage object not found: ${from}`)
                // One CopyObject copies at most 5 GB (AWS's CopyObject reference; UploadPartCopy is the route
                // above it). Say so rather than relay S3's wording.
                if (name === 'InvalidRequest' && /larger than the maximum allowable size/i.test(message ?? '')) {
                    throw new Error(
                        `storage copy: ${from} is over the 5 GB one CopyObject call can copy (multipart copy is not implemented)`,
                        { cause: error },
                    )
                }
                throw error
            }
        },

        async createUploadTarget(key, { contentType, maxBytes }) {
            // A presigned POST the browser uploads to directly. The Conditions ARE the security policy:
            // the object lands at exactly `key` (server-built — never client-chosen), its declared
            // Content-Type must equal `contentType`, and its size must fall within [0, maxBytes]. AWS
            // rejects any POST that violates them (403/400) before a byte is stored.
            const { url, fields } = await createPresignedPost(client, {
                Bucket: bucket,
                Key: key,
                Conditions: [
                    ['content-length-range', 0, maxBytes],
                    ['eq', '$Content-Type', contentType],
                ],
                Fields: { 'Content-Type': contentType },
                Expires: 900,
            })
            return { url, fields }
        },
    }
}
