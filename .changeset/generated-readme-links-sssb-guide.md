---
'@sssb/create': patch
---

### A generated workspace's README links SSSB's adoption guide, and the generator mentions `pnpm dev`

**Kind.** none

**Action.** none

**What changed.** The `README.md` that `@sssb/create` writes now links SSSB's adoption guide (`docs/adopting.md`) and
its reference app, both at the commit the workspace pins, says why the app sits under `apps/`, and points its
"Upgrading SSSB" section at the guide's "Upgrading by release" steps. The next steps the generator prints end by
saying that `pnpm dev` runs the app, seeded and offline.
