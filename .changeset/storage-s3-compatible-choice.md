---
'@sssb/kit': minor
'@sssb/cdk': minor
---

### Object storage on any S3-compatible store: `STORAGE_PROVIDER=s3-compatible`

**Kind.** operator

**Action.** optional

**What changed.** The storage port has a third choice beside `s3` and `none`: `s3-compatible`, for Cloudflare R2, MinIO
and Backblaze B2, through the same S3 adapter. It is a choice of its own, never inferred from `s3` reading an endpoint.
It requires `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY` and `STORAGE_UPLOAD_TARGET` (`post` if the store accepts a presigned POST, which
`createUploadTarget` is, or `none` if it does not, as Cloudflare documents for R2: `createUploadTarget` then fails with
an error that names the setting, and every other method works), and fails at boot naming each one missing. It reads
`STORAGE_FORCE_PATH_STYLE` (`true` or `false`) when set, which MinIO needs. It does not use `AWS_REGION` or the AWS
key pair, which Lambda reserves. `SssbApp` accepts `params.ports.storage: 's3-compatible'`, builds no storage bucket
and grants no S3 access for it. `required-env.json` lists the choice, so this is a `minor`; an app that keeps `s3`,
`none` or no choice requires exactly what it did and keeps its bucket's logical id. Three cutover rows are new:
`storage-compatible-store`, `storage-compatible-credentials` and `storage-compatible-live`.

**To adopt.** Nothing, unless you want it. To use R2, MinIO or B2: set `ports: { storage: 's3-compatible' }` in
`apps/<app>/config/params.ts`, add the six settings to the server's environment from your infra (`app.server`; the
key pair kept out of the repository), and work the three cutover rows. Switching a deployed stack from `s3` takes its bucket
out of the stack (retained in production, deleted elsewhere), as `none` does: copy the objects first. A store without
presigned POST cannot take a browser upload through `createUploadTarget` yet.

**Now deletable.** A hand-written storage adapter, or a copy of `createS3Storage` with an endpoint, that only pointed
SSSB's storage port at another S3-compatible store.
