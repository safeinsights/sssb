---
'@sssb/eslint-plugin': minor
---

### SSSB's real adapters are imported only by `import()` anywhere outside an app's own real adapters

**Kind.** seam

**Action.** required

**What changed.** `sssb/no-kit-real-adapter-import` now covers every module in an app's `src/` and `config/`, tests
and stories included, not only its adapter registry and fakes. Outside `src/adapters/real/`, an import declaration of
`@sssb/kit/adapters/real/*` (the LLM client, S3 storage, the real-mode forms and providers, the migrate handler) fails
lint, `import type` and re-exports (`export … from`) included, because importing one loads its vendor SDK in simulated
mode too. `import()` stays allowed, and `src/adapters/real/` may still build on one. `sssb check-fences` probes it.

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
- A type the module needs from one of these adapters comes from the port it implements (`@sssb/kit/ports/*`) instead.

Modules outside `src/` and `config/` (`scripts/`, `tests/`, `infra/`) are not covered and need no change.
