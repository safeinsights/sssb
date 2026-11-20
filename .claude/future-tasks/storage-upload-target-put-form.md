# The storage port's upload target gains a PUT form (browser upload to R2 and other stores without presigned POST)

**Priority:** P2 · **Status:** open
**Decided in:** ADR-0015, section 6's R2 example and the second addendum's point 2 ("an upload target may be a POST or
a PUT"). Left open by `resolved/storage-s3-compatible-choice.md`, which made the choice and a setting that says whether
a store accepts presigned POST, and nothing more.

## Why

`createUploadTarget` returns an `UploadTarget` (`packages/kit/src/ports/storage.ts`): a URL and `fields`, the shape of an
S3 presigned POST, with the browser code written to it (fields first, then the file as multipart) and the fake serving
the same shape. Cloudflare documents R2's presigned URLs as GET, HEAD, PUT and DELETE, with POST "not currently
supported" (checked 2026-11-19). So on `STORAGE_PROVIDER=s3-compatible` with `STORAGE_UPLOAD_TARGET=none`, an app cannot
take a browser upload at all: `createUploadTarget` refuses, naming the setting. The port's promise that "the storage
backend must enforce" `maxBytes` also cannot be kept as written on a PUT: a presigned PUT has no `content-length-range`.

## What to build

1. **A PUT form of `UploadTarget`**, designed against S3 and R2 both: a discriminated union (`method: 'POST' | 'PUT'`;
   a POST has `fields`, a PUT has the `headers` the browser must send), so the browser code switches on it. Work out
   every consumer first (`rg 'createUploadTarget|UploadTarget'`: the showcase's upload route and component, the
   fake's upload route, the conformance suite, the test fixture) and keep the POST form as it is for every app that has
   one.
2. **The size ceiling, held another way**, which is the open question. ADR-0015 section 6 names two candidates, neither
   verified against R2: the route takes the file's size first, refuses it above the limit and signs that exact
   `Content-Length` into the URL (enforced at upload if R2 honours a signed length); or the upload lands under a staging
   key and is checked with `head` before the existing `copy` moves it into place, deleting an oversize one (always
   works, stores the bytes first). Measure the first against a real R2 bucket before choosing; do not assume it.
3. **Which form a store gets** is the setting's to say, not a guess: `STORAGE_UPLOAD_TARGET` gains `put`, beside `post`
   and `none` (`packages/kit/src/adapters/real/optional-ports.ts`). Adding a value is not a new required variable, so
   the required-environment snapshot does not change.
4. **The port contract suite and the fake** hold both forms to the same behaviours: the key lands exactly where the
   server built it, a wrong content type is refused, an oversize body is refused or deleted.

## Done when

- A browser upload into a real R2 bucket works end to end through `createUploadTarget`, with an oversize body refused
  (the live check is a cutover row's job; nothing in CI calls R2).
- An app on `s3` or on a store with presigned POST sees no change.
- The adopter reference's "What it cannot do yet" paragraph under `storage: 's3-compatible'` is replaced by what it can.
