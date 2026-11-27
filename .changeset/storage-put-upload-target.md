---
'@sssb/kit': minor
---

### `UploadTarget` has a PUT form, for stores without presigned POST

**Kind.** seam

**Action.** required

**What changed.** `StoragePort.createUploadTarget` returns an `UploadTarget` that is now one of two shapes: a
`PostUploadTarget` (`{ url, fields }`, with an optional `method: 'POST'`, unchanged for a store that has presigned
POST) or a `PutUploadTarget` (`{ method: 'PUT', url, headers }`: the browser PUTs the file as the body). Code that
reads `target.fields` no longer typechecks until it narrows. An app that stays on `s3` or a POST store gets the same
value at run time, plus `method: 'POST'` (a test that compares the whole target must expect it). `UploadConstraints` gains an optional `sizeBytes`, the exact size of the file the browser
will send. A PUT has no size policy, so its URL signs that size, and an adapter minting a PUT refuses a call without
it. `createFakeStorage({ uploadTarget: 'put' })` (`@sssb/kit/adapters/fake/storage`) is the fake's PUT form, and its
`/api/storage-upload` twin in the showcase serves it.

**To adopt.** Where your server passes `createUploadTarget`'s result through as JSON, change nothing but its type
(`UploadTarget`). Where it reads `.fields`, narrow first: `if (target.method === 'PUT') { … }` (a target whose
`method` is absent is a POST). In the browser, switch the same way: a POST appends `fields` and then the file to a
`FormData`; a PUT is `fetch(target.url, { method: 'PUT', headers: target.headers, body: file })`. If your mint route
has the client's file size, pass it as `sizeBytes` beside `maxBytes` (and refuse one over `maxBytes` first); a POST
store ignores it. A route that must hold the ceiling on a PUT store should `head` the object when the upload is
confirmed and `delete` one over `maxBytes`: the store holds a signed length only if it honours one. Your own storage
adapter (`@sssb/kit/ports/storage`) may keep returning the POST shape as it is.
