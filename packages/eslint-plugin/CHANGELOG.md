# @sssb/eslint-plugin

## 0.9.0

### Minor Changes

- 7fdb607: ### `publicOrigin` and `clientAddress`, and a lint rule against reading the raw request

    **Kind.** seam

    **Action.** required

    **What changed.** A new subpath, `@sssb/kit/adapters/edge-headers`, gives an app the visitor's origin
    (`publicOrigin(request)`) and address (`clientAddress(request)`). Behind `SssbApp`, `request.url` and `nextUrl` name the
    server's own bind address and port (3000), never the visitor's host, and the first `X-Forwarded-For` entry is whatever the visitor
    wrote. A new rule in the app preset, `sssb/no-raw-request-origin`, fails a module under `src/` (tests aside) that:

    - reads a forwarded header by name from a request's headers (`request.headers.get('x-forwarded-for')`, `X-Real-IP`,
      `CF-Connecting-IP`, `Forwarded`, `Host`, the other `X-Forwarded-*`);
    - takes the `origin`, `host`, `hostname` or `href` of `new URL(request.url)` or of `request.nextUrl`, by member or
      destructuring;
    - builds `new URL(path, request.url)` (or on `request.nextUrl`), a redirect included, except in the app's own
      `src/proxy.ts` (or `src/middleware.ts`), where Next relativizes a same-origin redirect or rewrite and nowhere else: a
      route handler's `NextResponse.redirect(new URL('/en/dashboard', request.url))` sends the visitor to the server's bind
      address;
    - passes `baseUrl: request.url`.

    "The request" is an object named `req`, `request` or `nextRequest` (with or without a leading `_`), or a `.req` or
    `.request` member (`ctx.request`): the `url` of a webhook, a row or a form field is someone else's, and reading its
    origin is correct code. The rule reads names, not types, so a request held under another name gets past it, as does
    the request's URL stored in a variable and used later, or a `request.nextUrl.clone()` handed to a redirect
    (safeinsights/sssb#242).

    **To adopt.** Run `pnpm lint` after upgrading. For each finding:

    ```ts
    import { clientAddress, publicOrigin } from '@sssb/kit/adapters/edge-headers'

    // A link a visitor follows: an email, a URL you store.
    const link = new URL(`/${locale}/accept-invite`, publicOrigin(request)).toString()

    // A rate limit, a lockout, an audit record's "from". undefined means unknown: never a free pass.
    const from = clientAddress(request)
    ```

    A redirect needs neither: `redirect('/path')` (from `next/navigation`) and a relative `Location` are right as they are; in
    a route handler, write `NextResponse.redirect(new URL('/en/dashboard', publicOrigin(request)))`. Reading `pathname` or
    `searchParams` from the request's URL is still allowed. Outside a request (a job), `publicOrigin()` needs the server's
    `PUBLIC_ORIGIN` (the operator entry of this release). In `pnpm dev`, `publicOrigin` is the dev server's own origin and
    `clientAddress` is `undefined`.

    **Now deletable.** A helper that builds the app's origin from `x-forwarded-host` and `x-forwarded-proto`, or from
    `request.url`; one that takes the client's address from `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP`; and a
    `baseUrl: request.url` passed to `sendOrgInvite` or `applyDemoPreset` (pass `publicOrigin(request)`).

### Patch Changes

- 0b7bafd: ### `sssb/no-raw-request-origin` counts only the request's own URL

    **Kind.** none

    **Action.** none

    **What changed.** The rule new in this release no longer reads every `.url` or `.nextUrl` as the request's: in its URL
    forms the object must be named like the request (`req`, `request`, `nextRequest`, or a `.req` or `.request` member), so
    `new URL(body.url).hostname`, `new URL(path, upstream.url)` and `baseUrl: config.url` pass, as the correct code they are.

## 0.8.0

No changes in this release.

## 0.7.0

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- 9d56c29: ### Lint fences and `sssb` checks that let a form through

    **Kind.** seam

    **Action.** required

    **What changed.**

    - A new app-side fence, `sssb/no-path-into-kit`, in the preset and in `sssb check-fences`' probes. An import,
      `import()`, `require` or type import that reaches `@sssb/kit` by a path into the package
      (`../node_modules/@sssb/kit/src/...`, an absolute path, a `file:` URL, the app's `@/` alias, a symbolic link), or any path through `node_modules`, fails
      lint. The kit ships its source, so such a path reached any internal past the exports map. A stylesheet or worker
      imported as `../node_modules/<package>/...` gets the same finding: import it by the package's name.
    - An app's `sssb.vendors` entry must be a package name (`stripe`, `@stripe/stripe-js`) or one subpath of it
      (`firebase/app`), either followed by `/*`, or a whole scope (`@stripe/*`), in lower case. Any other gitignore
      pattern (`@stripe/**`, `stripe-*`, `stripe/`) banned an import declaration and let `import()` through; it now fails
      the lint config, naming the entry. `sssb check-fences` lints a probe per entry through both vendor rules.
    - The import fences match a bare specifier cut at a resource query or hash too (`pg?raw`), and read more forms of a
      specifier: a template literal, a type `import('...')`, `import x = require(...)`, Vitest's `vi.mock` and
      `vi.importActual` family, `require.resolve`. A vendor or a path into the kit written one of those ways now fails
      lint where it passed.
    - `sssb check-e2e` fails a spec, or a module it imports, that names an `@sssb/kit` subpath as a string esbuild
      cannot follow (a plain `require` of a variable, say), not only beside `createRequire`. An object key, a type, and a
      kit `.md` or `.json` file named in code pass.
    - `sssb ci lint-typecheck-unit` holds doctor to every app it fans out over, as a bare `sssb doctor` does.
    - `secretGrantProblems` and `dataApiShapeProblems` (`@sssb/tools/assembly-checks`) read grants from
      `AWS::IAM::RolePolicy`, `UserPolicy` and `GroupPolicy`, from users' and groups' inline and AWS-managed policies,
      and from a Secrets Manager resource policy on the cluster's secret, and fail any other `AWS::IAM::*` type that
      could carry a grant. A `?` in a granted resource is a wildcard. A stack built on `SssbApp` alone is unaffected.

    **To adopt.** Run `pnpm lint` and `pnpm verify`. Import the framework by a published `@sssb/kit/...` subpath and any
    package by its name. Rewrite a `sssb.vendors` entry the lint config refuses in one of the accepted shapes. If your
    own infra fails an assembly check, the message names the resource that grants too much.

## 0.4.0

No changes in this release.

## 0.3.0

### Patch Changes

- 6ef0815: ### The lint preset now requires typescript-eslint 8.73

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/eslint-plugin` now depends on `typescript-eslint` `^8.73.0` (it was `^8.72.0`). 8.73.0 takes
    `minimatch` 11.0.1 or later, the first release that fixes GHSA-g3hv-75wg-m249 (a denial of service through a crafted
    glob; moderate, in your lint tooling only); 8.72 takes `minimatch` 10, which is affected. A workspace generated at 0.2.0
    or earlier also lists `typescript-eslint` `^8.72.0` in its own root `devDependencies`, and that range is what keeps 8.72
    and `minimatch` 10 in its lockfile.

    **To adopt.** Raise the workspace root's `typescript-eslint` to `^8.73.0` (or run `pnpm update typescript-eslint -r`) in
    the same change that upgrades `@sssb/eslint-plugin`, so the workspace holds one copy of it, at 8.73. A workspace
    generated from this release on already has that range.

## 0.2.0

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

- 73123b6: ### SSSB's real adapters are imported only by `import()` anywhere outside an app's own real adapters

    **Kind.** seam

    **Action.** required

    **What changed.** `sssb/no-kit-real-adapter-import` now covers every module of an app (tests, stories and `scripts/`
    included), not only its adapter registry and fakes. Outside `src/adapters/real/` and the vendor ban's carve-outs
    (`next.config.*`, `tests/contract/`, `infra/`), an import declaration of `@sssb/kit/adapters/real/*` (the real-adapter set, the LLM client,
    S3 storage, the real-mode forms and providers, the migrate handler) fails lint, re-exports (`export … from`) included,
    because importing one loads its vendor SDK in simulated mode too. `import()` stays allowed, so does a type-only
    `import type` or `export type` (it loads nothing), and `src/adapters/real/` may still build on one. `sssb check-fences`
    probes it.

    **To adopt.** Run `pnpm lint`. For each finding:

    - In a page, layout or screen that needs a real-mode-only component, load it with `import()` when the app is not
      simulated, as the starter's sign-in page does:

        ```tsx
        import { isSimulated } from '@sssb/kit/adapters/index'

        if (!isSimulated) {
            const { RealSignInForm } = await import('@sssb/kit/adapters/real/sign-in-form')
            return <SignInScreen body={<RealSignInForm returnTo={target} labels={labels} />} />
        }
        ```

    - Anywhere else (a route, a domain module, a job), move the import into a module in the app's own
      `src/adapters/real/` and reach it through the app's registry (`src/adapters/index.ts`), which loads `real/` with
      `import()` when `!isSimulated`.
    - A script that runs a real adapter on purpose (a fixture recorder, say) loads it with `await import()` too.
    - An import that only needs a type becomes `import type { … }`, not `import { type … }`, which still loads the module.

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

- 7cd28e2: ### SSSB's packages are on npm, and a release is a plain version

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit`, `@sssb/tools`, `@sssb/eslint-plugin`, `@sssb/cdk` and `@sssb/create` are public, and
    SSSB's release flow publishes them to npm with provenance at one version. Release candidates (`-rc.N` tarballs on a
    GitHub prerelease) end here: this release's notes carry every change since the first candidate, and later releases are
    plain `0.x.y` versions on npm only. `pnpm create @sssb` now fetches the generator from npm, and the workspace it writes
    depends on each package at `^` its version.

    **To adopt.** In each workspace package that depends on an `@sssb/*` package by a release-candidate tarball URL (or a
    `file:` path), replace the URL with the version, and drop any `overrides` you kept for them:

    ```json
    {
        "@sssb/kit": "^0.2.0",
        "@sssb/tools": "^0.2.0"
    }
    ```

    Then `pnpm install`, commit the lockfile, and run `pnpm exec sssb doctor`: it reports a workflow or plugin marketplace
    pin that is not this release's commit, and you move each pin it names. Staying on a candidate's tarballs keeps working,
    but no later release ships as tarballs.

    **Now deletable.** Tarball URLs copied from a prerelease's notes, the `sha512` checks made against them, and any
    `overrides` or `file:` paths that pointed `@sssb/*` at a downloaded tarball.

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

- ddadf65: ### No "Pages directory cannot be found" when linting from the workspace root

    **Kind.** none

    **Action.** none

    **What changed.** The preset tells Next's lint rules where each app is (`settings.next.rootDir`), so ESLint run from
    the workspace root no longer prints "Pages directory cannot be found", and `@next/next/no-html-link-for-pages`
    checks links against the app's routes from there too, rather than skipping them.

## 0.2.0-rc.2

### Minor Changes

- 73123b6: ### SSSB's real adapters are imported only by `import()` anywhere outside an app's own real adapters

    **Kind.** seam

    **Action.** required

    **What changed.** `sssb/no-kit-real-adapter-import` now covers every module of an app (tests, stories and `scripts/`
    included), not only its adapter registry and fakes. Outside `src/adapters/real/` and the vendor ban's carve-outs
    (`next.config.*`, `tests/contract/`, `infra/`), an import declaration of `@sssb/kit/adapters/real/*` (the real-adapter set, the LLM client,
    S3 storage, the real-mode forms and providers, the migrate handler) fails lint, re-exports (`export … from`) included,
    because importing one loads its vendor SDK in simulated mode too. `import()` stays allowed, so does a type-only
    `import type` or `export type` (it loads nothing), and `src/adapters/real/` may still build on one. `sssb check-fences`
    probes it.

    **To adopt.** Run `pnpm lint`. For each finding:

    - In a page, layout or screen that needs a real-mode-only component, load it with `import()` when the app is not
      simulated, as the starter's sign-in page does:

        ```tsx
        import { isSimulated } from '@sssb/kit/adapters/index'

        if (!isSimulated) {
            const { RealSignInForm } = await import('@sssb/kit/adapters/real/sign-in-form')
            return <SignInScreen body={<RealSignInForm returnTo={target} labels={labels} />} />
        }
        ```

    - Anywhere else (a route, a domain module, a job), move the import into a module in the app's own
      `src/adapters/real/` and reach it through the app's registry (`src/adapters/index.ts`), which loads `real/` with
      `import()` when `!isSimulated`.
    - A script that runs a real adapter on purpose (a fixture recorder, say) loads it with `await import()` too.
    - An import that only needs a type becomes `import type { … }`, not `import { type … }`, which still loads the module.

### Patch Changes

- ddadf65: ### No "Pages directory cannot be found" when linting from the workspace root

    **Kind.** none

    **Action.** none

    **What changed.** The preset tells Next's lint rules where each app is (`settings.next.rootDir`), so ESLint run from
    the workspace root no longer prints "Pages directory cannot be found", and `@next/next/no-html-link-for-pages`
    checks links against the app's routes from there too, rather than skipping them.

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
