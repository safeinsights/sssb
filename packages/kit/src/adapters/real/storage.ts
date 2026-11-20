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
    /** `STORAGE_UPLOAD_TARGET`: `post` if the store accepts a presigned POST, `none` if it does not. */
    uploadTarget: string
    /** `STORAGE_FORCE_PATH_STYLE`: `true`, `false`, or unset (empty counts as unset) for the SDK's own addressing. */
    forcePathStyle?: string | undefined
}

/**
 * The storage port on an S3-compatible store: the same adapter as `createRealStorage`, pointed at `endpoint` with the
 * store's own key pair. Everything but the upload target is S3's API, which these stores implement (ADR-0015, section
 * 6 lists what R2 does). `createUploadTarget` is an S3 presigned POST, which R2 does not accept, so it follows
 * `uploadTarget`: with `none` it fails naming the setting rather than minting a URL the store would refuse.
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
        // The SDK's default (since v3.729) adds CRC32 checksum headers to PutObject and drops Content-MD5 from
        // DeleteObjects, which several S3-compatible stores reject: Cloudflare tells R2 users to ask for checksums only
        // where an operation requires one. AWS itself accepts both, so the `s3` choice keeps the default.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    })
    if (target === 'post') return s3
    return {
        ...s3,
        createUploadTarget: async () => {
            throw new Error(
                'storage createUploadTarget: STORAGE_UPLOAD_TARGET=none, so this store is declared not to accept a ' +
                    'presigned POST (Cloudflare R2 does not). Set STORAGE_UPLOAD_TARGET=post for a store that does, ' +
                    'such as MinIO, or upload another way.',
            )
        },
    }
}
