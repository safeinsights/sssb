---
'@sssb/create': patch
'@sssb/kit': patch
---

### A generated workspace's README links SSSB's adoption guide, and the generated app stops calling itself a template

**Kind.** none

**Action.** none

**What changed.** The `README.md` that `@sssb/create` writes now links SSSB's adoption guide (`docs/adopting.md`) and
its reference app, both at the commit the workspace pins, says why the app sits under `apps/`, names the `UPDATE-ME`
tags in `infra/lib/tags.ts` to replace before a deploy (they were `TEMPLATE-UPDATE-ME`), and points its "Upgrading
SSSB" section at each release's "Upgrading to this release" commands and the guide's "Upgrading by release". The next steps the generator prints end by saying that
`pnpm dev` runs the app. The generated app's welcome subtitle and comments no longer call it a template. The app
guide says where to read its two worked examples, the first migration and the items route, once you have removed
them, and the `scheduled-tick` cutover row no longer mentions two example apps.
