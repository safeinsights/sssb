# Storage on any S3-compatible store (R2, MinIO, Backblaze B2)

**Priority:** P2 · **Status:** open, accepted to build now
**Decided in:** ADR-0015, section 1 and the second addendum (2026-11-19). The R2 worked example (section 6) has the
facts about R2.

## Why

Most object stores speak the S3 API. SSSB's S3 adapter already accepts another endpoint: `createS3Storage`
(`packages/kit/src/adapters/real/s3-storage.ts`, published as `@sssb/kit/adapters/real/s3-storage`) takes `endpoint`,
`credentials` and `forcePathStyle`. Only the registry drops them: `createRealStorage`
(`packages/kit/src/adapters/real/storage.ts`) passes the bucket and region alone. So "a different bucket" is
configuration, not a new adapter.

## What to build

1. **A storage choice of its own, not an inference.** The switch rule
   (`packages/kit/src/adapters/real/optional-ports.ts`) forbids choosing behaviour from which settings happen to be set,
   so the endpoint gets its own `STORAGE_PROVIDER` value (say `s3-compatible`) beside `s3` and `none`, with required
   settings: `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`,
   and optionally `STORAGE_FORCE_PATH_STYLE`. Not `AWS_REGION` or the AWS key pair: Lambda reserves those for the
   function's own role and region.
2. **The registry passes them to `createS3Storage`.**
3. **`SssbApp`** (`packages/cdk/src/sssb-app.js`, `packages/cdk/src/optional-ports.js`) builds no S3 bucket and grants
   no S3 access for the new choice, and the stateful logical ids are unchanged for apps that keep `s3` (the snapshot
   test).
4. **The required-environment snapshot** (`packages/kit/release-snapshots/required-env.json`) gains the choice, so the
   changeset files `minor`.
5. **The upload target on R2.** R2 has no presigned POST, which `createUploadTarget` is (section 6 quotes Cloudflare's
   page). So on R2 browser-direct upload does not work until the storage port gains a PUT form of `UploadTarget`. Either
   make `createUploadTarget` throw a clear, named error on this choice, or take on the PUT form here, designed against
   both S3 and R2 as the second addendum's point 2 asks. Decide, and record which.

## Done when

- `s3-compatible` boots with its settings and fails at boot without them, naming each (tests seen red first).
- An esbuild graph test shows nothing new loads for the other choices.
- `SssbApp` builds no bucket for it (a construct test).
- The adopter reference says how to point at R2, MinIO or B2, and what R2 cannot do yet.
- A cutover row names the live check (a round trip of every port method against a real R2 bucket), since nothing here
  calls R2.
