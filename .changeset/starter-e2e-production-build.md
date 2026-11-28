---
'@sssb/create': patch
---

### A generated app's e2e runs against a production build on CI

**Kind.** scaffold

**Action.** optional

**What changed.** SSSB's reusable workflow sets `E2E_BUILD=1` on its e2e job, but the app the generator writes ignored
it and ran its e2e against `next dev`, so CI never ran `next build` for it: a change that breaks the production build
(a client-only hook in a server component, say) passed every check. The generated app now has `build:e2e` and
`start:e2e` scripts, and its `playwright.config.ts` builds and serves the production build when `E2E_BUILD=1`, with a
longer server start-up budget for the build. Locally, with the flag unset, the suite stays on `next dev`.

**To adopt.** In an existing workspace, add two scripts to `apps/<app>/package.json`, under its `"scripts"`:

```json
{
    "scripts": {
        "build:e2e": "NEXT_TELEMETRY_DISABLED=1 E2E_BUILD=1 APP_MODE=simulated next build",
        "start:e2e": "E2E_BUILD=1 APP_MODE=simulated sssb serve-standalone"
    }
}
```

and in `apps/<app>/playwright.config.ts`, branch the web server on the flag:

```ts
const E2E_BUILD = process.env['E2E_BUILD'] === '1'
// in webServer:
command: E2E_BUILD ? 'pnpm run build:e2e && pnpm run start:e2e' : 'pnpm dev',
timeout: E2E_BUILD ? 180_000 : 120_000,
```
