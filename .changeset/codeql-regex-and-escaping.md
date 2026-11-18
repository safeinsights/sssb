---
'@sssb/tools': patch
'@sssb/kit': patch
'@sssb/eslint-plugin': patch
---

### Linear-time trims, and complete glob escaping

**Kind.** none

**Action.** none

**What changed.** The doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) and `contractDatabaseName`
(`@sssb/kit/testing`) trim trailing slashes, quotes, punctuation and underscores with loops instead of regexes that
took time quadratic in a long run of the character; their results are unchanged. `sssb doctor` substitutes every `*`
in a tsconfig `paths` target, as TypeScript does. `@sssb/eslint-plugin`'s app preset also escapes a backslash when it
turns a name into a glob; no app can reach that case today (an app directory whose name holds a backslash cannot load
its `lint-exceptions.mjs`, the only place the escaped name is used), so nothing an adopter sees changes.
