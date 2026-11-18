---
'@sssb/eslint-plugin': minor
---

### SSSB's real adapters are imported only by `import()` anywhere outside an app's own real adapters

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
