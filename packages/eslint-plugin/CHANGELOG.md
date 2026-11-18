# @sssb/eslint-plugin

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

### Minor Changes

- df41bde: ### An app's own vendor SDKs are named in its `package.json`

    **Kind.** seam

    **Action.** required

    **What changed.** The vendor-SDK ban is SSSB's list plus the app's own: an app that owns an adapter for a vendor SSSB
    has no port for names that SDK in its `package.json`, and `@sssb/eslint-plugin`'s preset adds it to the ban. A pattern
    that starts with `!` is refused there and in the rules' options, so the app's list can only add.

    **To adopt.** If the app's fork added an SDK to `vendorSdkPattern` in `eslint.config.mjs`, move it to the app's
    `package.json`: `"sssb": { "vendors": ["stripe", "stripe/*"] }`, in the same gitignore-style patterns.

    **Now deletable.** Vendor SDK names added by hand to a copy of SSSB's `vendorSdkPattern`.

- df41bde: ### `@sssb/eslint-plugin`: the lint fences as a preset an app composes

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

- df41bde: ### `sssb check-fences`: the fences as the app's config composes them

    **Kind.** seam

    **Action.** required

    **What changed.** `sssb check-fences`, run from the app, fails when the app's composed lint config has switched off or
    narrowed one of SSSB's fences: a rule turned off or down for some files, an `ignores` or a nested config file that
    drops a directory, a processor or another parser, a changed vendor list, an exception wider than its file, or a fence
    finding in the app's own files that an `eslint-disable`, an inline `/* eslint */` comment or a suppressions file lets
    through. It compares every source file's effective config with the preset's and lints probe files through the app's
    config. Typed linting (`parserOptions.project` or `projectService`) cannot pass it yet: the probe files are outside the
    TypeScript project.

    **To adopt.** Run `pnpm exec sssb check-fences` from each app in the app's lint or verify script, and fix what it names:
    an exception goes in `lint-exceptions.mjs`, an app vendor in `package.json`'s `sssb.vendors`.

    **Now deletable.** A hand-kept list of which ESLint blocks re-list SSSB's patterns, and any review checklist item that
    asks whether an app's config still enforces the vendor, `process.env` or tenancy bans.

### Patch Changes

- 846d11d: ### Linear-time trims, and complete escaping

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
