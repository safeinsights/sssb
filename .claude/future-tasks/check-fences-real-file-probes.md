# check-fences probes each real file, not only fixed probe paths

**Priority:** P3 · **Status:** open
**Found by:** the independent review of ADR-0014's P6, round 3 (2026-11-18, `feat/eslint-plugin`).

## What is true

`sssb check-fences` (`packages/eslint-plugin/src/check-fences.js`) proves the fences hold through an app's composed
config in four ways: the effective config of every source file against the preset's, probe files linted at fixed
virtual paths (`apps/<app>/src/domain/__sssb_fence_probe__.ts` and the like, `packages/eslint-plugin/src/probes.js`), each
`lint-exceptions.mjs` entry and a sibling, and every fence finding in the app's own files.

What still gets past it is config code written to deceive, and every such case keys on the probes' public file name:

- a parser that copies the real one's `meta` and returns an empty program for files that are not probes;
- the preset's blocks rewritten (`preset.map(…)`) to bind `sssb` to a look-alike plugin whose rules fire only on
  probe files;
- eslint-plugin-react, or another module the rules read, rewritten the same way (the plugin, its rules, its patterns
  and react's `create` are frozen or captured since round 3, so this needs a module the freeze does not reach).

The fences' threat model is an adopter's config weakening a fence by accident (`docs/decision-log.md`, the P6 entry):
a config written to deceive can as well delete the preset, and no check stops that. So these are out of scope, not
holes, and this task is only worth doing if it is cheap.

## The design

For each source file the walk finds, lint probe code at that file's own path (`lintText` with `filePath` the real file),
assembled from one trigger per fence the preset enables on that file, and require each of those fences to report:

| Rule                                   | Trigger                              | Where it can be written |
| -------------------------------------- | ------------------------------------ | ----------------------- |
| `sssb/no-vendor-import`                | `import '@aws-sdk/client-s3'`        | ES modules              |
| `sssb/no-dynamic-vendor-import`        | `require('@aws-sdk/client-s3')`      | every file              |
| `sssb/no-next-font-google`             | `import 'next/font/google'`          | ES modules              |
| `sssb/no-real-adapter-import`          | `import '@/adapters/real/x'`         | ES modules              |
| `sssb/no-static-real-adapter-import`   | `import '@/adapters/real/x'`         | ES modules              |
| `sssb/no-kit-real-adapter-import`      | `import '@sssb/kit/adapters/real/x'` | ES modules              |
| `sssb/no-dynamic-real-adapter-import`  | `import('./real/x')`                 | every file              |
| `sssb/no-process-env`                  | `process.env.X`                      | every file              |
| `sssb/no-run-mode-env`                 | `process.env.APP_MODE`               | every file              |
| `sssb/no-raw-db-handle`                | `db.getDb()`                         | every file              |
| `sssb/no-direct-mkdtemp`               | `mkdtempSync('x')`                   | every file              |
| `sssb/no-literal-a11y-copy`, `…-jsx-…` | `<b aria-label="x">y</b>`            | `.tsx`, `.jsx` only     |

A file whose path the config spares (by name, by parser, by plugin) then fails, wherever it is.

## The cost, and why it waits

One more `lintText` per source file. `check-fences` already takes about 5s on the showcase (233 files: two config
calculations and two full lints per file; measured 2026-11-18); this adds a third lint, on generated code. Pages'
console is larger. Do it if `check-fences` becomes the gate for an adversarial setting (a third party's app config),
or if the cost can be cut by probing one file per directory and config (files whose effective config is identical
share a probe).
