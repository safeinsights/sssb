---
'@sssb/kit': minor
---

### Conformance and contract checks that passed what they should have failed

**Kind.** seam

**Action.** required

**What changed.**

- The contract runner (`@sssb/kit/testing/contract`) connects through SSSB's real `pg` adapter. It built a bare
  driver pool, so a contract run saw a different driver configuration from the deployed app: a `date` column came
  back as a `Date`, where the app gets a string.
- `conformanceSuite` refuses, while the suite file is collected, an `appDir` that is not the package the suite file
  is in. A suite pointed at another app used to run every file-reading check over that app's files and pass.
- `i18n-parity` parses each message with the ICU parser. Text inside a plural or select branch is no longer read as
  a placeholder, so a translated branch passes, and each argument's name and type, inside branches too, and the
  rich-text tags must match between the two catalogs. A message that is valid ICU on one side only (`Press <Enter> to
send` against a valid translation) fails, naming the side. A value that is ICU on neither side, a raw string for
  `t.raw()` (markup, JSON, a template), is compared only by its `{name}` placeholders.
- The RLS coverage proof reads each policy on its own. A table with a PERMISSIVE policy whose `USING` or
  `WITH CHECK` ignores `app.current_tenant` fails, even beside an isolating policy (permissive policies are OR-ed).
- `real-auth-provider` follows `require('...')` and `import x = require('...')`.

**To adopt.** Run `pnpm verify` and `pnpm test:contract`. A proof or test that compared a `date` column with a JS
`Date` compares it with the string (`'2026-10-03'`). A catalog message the parity check now refuses is fixed in the catalog: close the tag, or quote the literal (`'<Enter>'`), on the side it names.
