---
'@sssb/eslint-plugin': minor
---

### An app's own vendor SDKs are named in its `package.json`

**Kind.** seam

**Action.** required

**What changed.** The vendor-SDK ban is SSSB's list plus the app's own: an app that owns an adapter for a vendor SSSB
has no port for names that SDK in its `package.json`, and `@sssb/eslint-plugin`'s preset adds it to the ban. A pattern
that starts with `!` is refused there and in the rules' options, so the app's list can only add.

**To adopt.** If the app's fork added an SDK to `vendorSdkPattern` in `eslint.config.mjs`, move it to the app's
`package.json`: `"sssb": { "vendors": ["stripe", "stripe/*"] }`, in the same gitignore-style patterns.

**Now deletable.** Vendor SDK names added by hand to a copy of SSSB's `vendorSdkPattern`.
