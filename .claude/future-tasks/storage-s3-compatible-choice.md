# Storage on any S3-compatible store (R2, MinIO, Backblaze B2)

**Priority:** P2 · **Status:** open, accepted to build now
**Decided in:** ADR-0015, section 1 and the second addendum (2026-11-19), whose "Decided in writing this" makes it a
choice of its own. Section 6's R2 worked example has the facts about R2.

## Why

Most object stores speak the S3 API. SSSB's S3 adapter already accepts another endpoint: `createS3Storage`
(`packages/kit/src/adapters/real/s3-storage.ts`, published as `@sssb/kit/adapters/real/s3-storage`) takes `endpoint`,
`credentials` and `forcePathStyle`. Only the registry drops them: `createRealStorage`
(`packages/kit/src/adapters/real/storage.ts`) passes the bucket and region alone. So "a different bucket" is
configuration, not a new adapter.

## What to build

1. **A `STORAGE_PROVIDER` choice of its own, `s3-compatible`**, beside `s3` and `none`
   (`packages/kit/src/adapters/real/optional-ports.ts`).
    - Its required settings, each with a cutover row in the choice's `env` map: `STORAGE_BUCKET`, `STORAGE_ENDPOINT`,
      `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`.
    - `STORAGE_FORCE_PATH_STYLE` is optional.
    - Not `AWS_REGION` or the AWS key pair: Lambda reserves those for the function's own role and region.
2. **The registry passes them to `createS3Storage`.**
3. **`SssbApp`** (`packages/cdk/src/sssb-app.js`, `packages/cdk/src/optional-ports.js`):
    - `optional-ports.js` gains the choice;
    - the construct builds no S3 bucket and grants no S3 access for it. Today it builds the bucket for every choice but
      `none`, so that test changes to `s3` alone;
    - the stateful logical ids are unchanged for apps that keep `s3` (the snapshot test).
4. **The required-environment snapshot** (`packages/kit/release-snapshots/required-env.json`) gains the choice, so the
   changeset files `minor`.
5. **R2's upload target is not built here.** R2 has no presigned POST, which `createUploadTarget` is (section 6 quotes
   Cloudflare's page), while MinIO's does accept one. So on `s3-compatible` the upload target is explicit, never
   guessed: a setting (proposed `STORAGE_UPLOAD_TARGET`, `post` or `none`) says whether the store accepts presigned
   POST, and with `none` `createUploadTarget` fails with an error naming the setting. Record a future task for the
   storage port's PUT form, designed against S3 and R2 both (second addendum, point 2).

## Done when

- `s3-compatible` boots with its settings and fails at boot without them, naming each (tests seen red first).
- The `s3` and `none` choices require exactly what they did: the snapshot's other entries are unchanged.
- `SssbApp` builds no bucket for it (a construct test).
- `createUploadTarget` follows the upload-target setting, refusing with the named error on `none` (tests).
- The adopter reference says how to point at R2, MinIO or B2, and what the choice cannot do yet.
- A cutover row names the live check: a round trip of every other port method against a real R2 bucket. Nothing here
  calls R2.
