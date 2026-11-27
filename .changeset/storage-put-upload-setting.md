---
'@sssb/kit': minor
---

### `STORAGE_UPLOAD_TARGET=put` for a store that takes a presigned PUT

**Kind.** operator

**Action.** optional

**What changed.** `STORAGE_UPLOAD_TARGET` (read with `STORAGE_PROVIDER=s3-compatible`) accepts `put` beside `post` and
`none`: `createUploadTarget` then mints a presigned PUT, which Cloudflare R2 accepts and a presigned POST it does not.
It is not a new required variable, so the required-environment snapshot is unchanged. `createS3Storage` takes the same
choice as `uploadTarget: 'put'`; the client it builds then defaults `requestChecksumCalculation` to `WHEN_REQUIRED`,
and a client you pass in must already be set so (the SDK's default signs the checksum of an empty body into the URL,
and `createUploadTarget` throws, naming the setting, when it sees one).

**To adopt.** On R2, set `STORAGE_UPLOAD_TARGET=put`, pass `sizeBytes` when you mint (see the `UploadTarget` change),
and give the bucket a CORS rule that lets your app's origin `PUT` with the `Content-Type` header. Check on a real
bucket that an upload lands at the key, that a body of another length or type is refused, and whether R2 holds the
signed length or your `head` check does; cutover row `storage-compatible-store` says how.

**Now deletable.** A route that receives the file and calls `put` only because the store had no presigned POST.
