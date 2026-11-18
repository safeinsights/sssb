---
'@sssb/kit': patch
---

### The real S3 storage adapter is published: `@sssb/kit/adapters/real/s3-storage`

**Kind.** seam

**Action.** optional

**What changed.** The storage adapter SSSB's real-mode registry builds is now published as
`createS3Storage(options)` from `@sssb/kit/adapters/real/s3-storage`, so an app that needs storage outside SSSB's
registry (a simulated app run against a real bucket or an S3-compatible endpoint, say) uses the same adapter rather
than a copy. The options are `bucket` (required), and `region`, `endpoint`, `credentials` (values or a provider) and
`forcePathStyle`, each passed to the S3 client as the AWS SDK names it; or `client`, an `S3Client` you built, used as it
is. A `client` together with any of the four client options is refused, since they would be ignored. Left out, region
and credentials come from the AWS SDK's own lookup. The storage port (`@sssb/kit/ports/storage`) is unchanged.

**To adopt.** Where the app builds the storage port itself, import the factory from a module in its own
`src/adapters/real/` (elsewhere on the app's request path SSSB's real adapters are loaded only with `import()`):

```ts
import { createS3Storage } from '@sssb/kit/adapters/real/s3-storage'

// adapters/real/ is where an app reads process.env
const storage = createS3Storage({
    bucket: process.env.STORAGE_BUCKET as string,
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:9000', // an S3-compatible endpoint; leave out for AWS
    forcePathStyle: true, // as most S3-compatible endpoints need
})
```

`credentials` takes what the AWS SDK's `S3Client` takes, static keys or a provider such as `fromIni()` from
`@aws-sdk/credential-providers` (a dependency of the app's own).

**Now deletable.** A copy of SSSB's S3 storage adapter (a `StoragePort` built on `@aws-sdk/client-s3`, its presigned
download URLs forced to `attachment`) kept in the app's `adapters/real/` because the kit did not publish one.
