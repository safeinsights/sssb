import type { StoragePort } from '../../ports/storage'
import { createS3Storage } from './s3-storage'
import { assertEndpoint, parseForcePathStyle, parseUploadTarget } from './storage-settings'

/**
 * The storage the real-mode registry builds (`./index.ts`): the published S3 adapter (`./s3-storage.ts`,
 * `@sssb/kit/adapters/real/s3-storage`) on the deployment's bucket and region.
 */
export function createRealStorage(bucket: string, region: string): StoragePort {
    return createS3Storage({ bucket, region })
}

/**
 * Where an S3-compatible store (Cloudflare R2, MinIO, Backblaze B2) is, as `STORAGE_PROVIDER=s3-compatible` reads it
 * (./optional-ports.ts). The two strings that choose behaviour arrive as the environment gave them and are checked
 * here, so a wrong value fails at boot naming its variable.
 */
export interface CompatibleStorageSettings {
    /** `STORAGE_BUCKET`. */
    bucket: string
    /** `STORAGE_ENDPOINT`: the store's S3 API endpoint, as an http(s) URL. */
    endpoint: string
    /** `STORAGE_REGION`: what the store signs requests for (R2 takes `auto`). Not `AWS_REGION`, which Lambda reserves. */
    region: string
    /** `STORAGE_ACCESS_KEY_ID`. Not `AWS_ACCESS_KEY_ID`, which Lambda reserves for the function's own role. */
    accessKeyId: string
    /** `STORAGE_SECRET_ACCESS_KEY`. */
    secretAccessKey: string
    /** `STORAGE_UPLOAD_TARGET`: `post` if the store accepts a presigned POST, `put` if it takes a presigned PUT, `none` for no browser upload. */
    uploadTarget: string
    /** `STORAGE_FORCE_PATH_STYLE`: `true`, `false`, or unset (empty counts as unset) for the SDK's own addressing. */
    forcePathStyle?: string | undefined
}

/**
 * The storage port on an S3-compatible store: the same adapter as `createRealStorage`, pointed at `endpoint` with the
 * store's own key pair. Everything but the upload target is S3's API, which these stores implement (ADR-0015, section
 * 6 lists what R2 does). `createUploadTarget` follows `uploadTarget`: an S3 presigned POST for `post` (MinIO),
 * a presigned PUT for `put` (R2, which has no POST), and with `none` it fails naming the setting rather than minting a
 * URL the store would refuse.
 *
 * AUTHORED — CUTOVER (`storage-compatible-store`, `storage-compatible-credentials`, and the live round trip
 * `storage-compatible-live`): typechecked and run with the SDK's transport replaced, never against a real store.
 */
export function createCompatibleStorage(settings: CompatibleStorageSettings): StoragePort {
    const { bucket, endpoint, region, accessKeyId, secretAccessKey, uploadTarget } = settings
    const target = parseUploadTarget(uploadTarget)
    const forcePathStyle = parseForcePathStyle(settings.forcePathStyle)
    assertEndpoint(endpoint)

    const s3 = createS3Storage({
        bucket,
        region,
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle,
        uploadTarget: target === 'put' ? 'put' : 'post',
        // The SDK's default (since v3.729, `WHEN_SUPPORTED`) puts a CRC32 checksum on every PutObject, which stores
        // older than that default can reject; Cloudflare tells R2 users to ask for checksums only where an operation
        // requires one. `WHEN_REQUIRED` does that, and no more: DeleteObjects requires one, so it still carries CRC32
        // and no Content-MD5, which a store that wants MD5 would refuse (the live row, `storage-compatible-live`, runs
        // `delete` against the real store for that). AWS accepts both, so the `s3` choice keeps the default.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    })
    if (target !== 'none') return s3
    return {
        ...s3,
        createUploadTarget: async () => {
            throw new Error(
                'storage createUploadTarget: STORAGE_UPLOAD_TARGET=none, so this deployment takes no browser upload. Set ' +
                    'STORAGE_UPLOAD_TARGET=post for a store that accepts a presigned POST (MinIO) or put for one that ' +
                    'takes a presigned PUT instead (Cloudflare R2), or upload another way.',
            )
        },
    }
}
