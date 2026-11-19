---
'@sssb/kit': minor
'@sssb/cdk': minor
---

### An app that stores no files needs no S3 bucket

**Kind.** operator

**Action.** required

**What changed.** The storage port is one of SSSB's optional ports, with the switch `STORAGE_PROVIDER` (`s3` or
`none`). With `none` the port is absent: real mode no longer requires `STORAGE_BUCKET`, never loads the S3 SDK, and a
call through the port (or a job handler's) throws an error naming the switch. `AWS_REGION` is now required only by
what calls AWS: storage on `s3`, `JOBS_RUNNER=codebuild` and `DATABASE_TRANSPORT=data-api`. An unset switch is `s3`, so
a deployment that sets nothing requires exactly what it did. `SssbApp` sets the switch from `params.ports.storage`, and
with `none` builds no storage bucket, sets no `STORAGE_BUCKET` and grants the server no S3 access; with `s3` or left
out, the bucket keeps its logical id. `SssbApp`'s `storageBucket` is therefore `Bucket | undefined`.
`required-env.json` lists `STORAGE_PROVIDER`'s choices, and `AWS_REGION` under `JOBS_RUNNER`'s `codebuild`.

**To adopt.** Add `storage` to the `ports` in `apps/<app>/config/params.ts`: `'s3'` if your app stores files
(uploads, attachments, job artifacts), else `'none'`. Infra code that reads `app.storageBucket` handles `undefined`
(TypeScript now says where). Before switching a deployed stack to `none`, copy out what its bucket holds: a
`production: true` deployment retains the bucket outside the stack, and any other deletes it with its objects. A
deployment that does not use `SssbApp` sets `STORAGE_PROVIDER` itself.

**Now deletable.** A placeholder `STORAGE_BUCKET`, and a bucket created only so that real mode would start.
