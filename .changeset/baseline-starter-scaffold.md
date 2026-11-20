---
'@sssb/create': patch
---

### Starter and generated-workflow fixes to apply by hand

**Kind.** scaffold

**Action.** optional

**What changed.** A workspace generated from this release has these; an existing one applies them by hand, reading
each file in SSSB's repository at this release (`apps/starter`).

- `src/app/[locale]/signin/page.tsx` and `signin/picker-glue.tsx` take their `returnTo` through `sameOriginPath`
  (the entry "`sameOriginPath` is published"): the old check was an open redirect.
- `src/proxy.ts`: the matcher's excluded prefixes end at a slash (`api(?:/|$)`, `_next/`, `_vercel/`) and the API
  branch matches `/api` or `/api/...`, so a page named like `/apiary` reaches the proxy and the auth provider's
  middleware.
- `src/app/api/respond.ts` gains `readJsonObject` and `refuseNonJson`. `POST /api/items` and `POST /api/auth/org`
  answer 400, not 500, on a body that is not a JSON object or a field of the wrong type. `POST /api/auth/dev-signin`
  (simulated mode only) answers 415 to a request that is not `application/json`, so another site's page cannot sign
  a developer in.
- The Items card keeps the typed title and shows `items.addError` (new, in both catalogs) when a create fails.
- `playwright.demo.config.ts` forbids `test.only` on CI.
- The generated `.github/workflows/checks.yml`: its secret-scan job checks the gitleaks download's sha256 before
  running it, and its own checkouts set `persist-credentials: false`. SSSB's reusable workflow (`app-checks.yml`)
  does the same on every job, which reaches a workspace when it raises its workflow pin; its jobs take no steps of
  yours, so nothing of yours loses the token.

**To adopt.** Copy the changed lines from the named files. For the secret scan, copy the download, `sha256sum -c -`
and `tar -xzf` lines from SSSB's `.github/workflows/checks.yml`. `sssb remove-items` still takes the Items slice out
of an app generated from this release.
