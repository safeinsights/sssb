---
'@sssb/create': patch
---

### A generated app's e2e budgets fit its production build on CI

**Kind.** scaffold

**Action.** optional

**What changed.** The generated app's e2e suite ran on CI against its production build with the budgets sized for
`next dev`, where every route compiles on its first hit: 60 s a test, 15 s an assertion, and up to 45 s for a page to
hydrate or reload. A hang waited out the whole of that before it failed. On a production build (`E2E_BUILD=1`, which
SSSB's reusable workflow sets) a test now gets 15 s and an assertion 10 s, over four times what SSSB's own copy of this
suite needed in five CI runs, and the Simulator spec's waits for hydration and for the reload after a reset take the
assertion budget. Under `next dev`, locally, every budget is what it was.

**To adopt.** In `apps/<app>/playwright.config.ts`, where the config already reads `E2E_BUILD`, change the `expect`
line, and give the project its own test budget (leave the top-level `timeout: 60_000` as it is: `sssb remove-items`
matches the lines around it):

```ts
expect: { timeout: E2E_BUILD ? 10_000 : 15_000 },
projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] }, timeout: E2E_BUILD ? 15_000 : 60_000 }],
```

Measure your own suite before you copy the numbers: a spec of yours that waits for real work (a job, an email) needs a
budget of its own, at least three times what it takes on CI.
