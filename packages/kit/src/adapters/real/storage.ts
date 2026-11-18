import type { StoragePort } from '../../ports/storage'
import { createS3Storage } from './s3-storage'

/**
 * The storage the real-mode registry builds (`./index.ts`): the published S3 adapter (`./s3-storage.ts`,
 * `@sssb/kit/adapters/real/s3-storage`) on the deployment's bucket and region.
 */
export function createRealStorage(bucket: string, region: string): StoragePort {
    return createS3Storage({ bucket, region })
}
