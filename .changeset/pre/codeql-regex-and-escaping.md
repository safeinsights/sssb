---
'@sssb/tools': patch
'@sssb/kit': patch
'@sssb/eslint-plugin': patch
'@sssb/create': patch
---

### Linear-time trims, and complete escaping

**Kind.** none

**Action.** none

**What changed.** Trims that used regexes taking time quadratic in a long run of one character now use loops or an
index, with the same results: the doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) on trailing
slashes, quotes and `,;)`; `sssb doctor` on trailing slashes in `pnpm-workspace.yaml` globs; `@sssb/create` on a git
remote's trailing slashes; and `@sssb/eslint-plugin`'s package-edge rule on a specifier's `?query` or `#hash`.
`contractDatabaseName` (`@sssb/kit/testing`) trims its underscores by a loop too. `sssb doctor` still fills only the
first `*` of a tsconfig `paths` target, as TypeScript's resolver does, without `String#replace`. The app preset of
`@sssb/eslint-plugin` also escapes a backslash when it turns a name into a glob; no app can reach that case today (an
app directory whose name holds a backslash cannot load its `lint-exceptions.mjs`, the only place the name is used).
