---
'@sssb/eslint-plugin': minor
---

### `@sssb/eslint-plugin`: the lint fences as a preset an app composes

**Kind.** scaffold

**Action.** required

**What changed.** SSSB's lint fences moved out of the repository's `eslint.config.mjs` into `@sssb/eslint-plugin`. Its
preset, `configs.app({ root })`, is the base TypeScript, React and Next config plus every app-side fence, each a rule
with an id of its own (`sssb/no-vendor-import`, `sssb/no-process-env`, `sssb/no-raw-db-handle`, `sssb/no-jsx-literals`
and the rest), so a `no-restricted-imports` or `no-restricted-syntax` block of the app's own no longer replaces one.
It reads the app's `lint-exceptions.mjs` as before.

**To adopt.** Add `@sssb/eslint-plugin` and `eslint` to the app's devDependencies, and make the app's
`eslint.config.mjs`:

```js
import sssb from '@sssb/eslint-plugin'

export default [...(await sssb.configs.app({ root: import.meta.dirname })), ...yourOwnBlocks]
```

From a workspace root's config, pass the app's absolute directory (`join(import.meta.dirname, 'apps/<app>')`). Rename
any `eslint-disable` that named `no-restricted-imports`, `no-restricted-syntax` or `react/jsx-no-literals` for a fence
to the fence's `sssb/*` id, or better, remove it: `sssb check-fences` reports a fence an inline comment hides.

**Now deletable.** A fork's copy of SSSB's fences in its own `eslint.config.mjs`: the vendor-SDK, `process.env`,
run-mode, real-adapter, `next/font/google`, tenancy and i18n blocks and the patterns and selectors they re-list.
