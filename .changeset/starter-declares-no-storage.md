---
'@sssb/create': patch
---

### The starter declares that it stores no files

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `config/params.ts` `ports` entry has `storage: 'none'`, since the starter stores no
files. A workspace generated from now on deploys with no storage bucket and needs no `STORAGE_BUCKET`.

**To adopt.** Add `storage` to the `ports` in your own `config/params.ts`: `'s3'` if your app stores files, else
`'none'` (the entry "An app that stores no files needs no S3 bucket" says what each does to a deployed stack).
