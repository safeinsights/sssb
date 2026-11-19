---
'@sssb/tools': patch
'@sssb/create': patch
---

### `sssb add-app <slug>` writes a second app into your workspace

**Kind.** none

**Action.** none

**What changed.** `pnpm exec sssb add-app <slug>` writes a new app under `apps/<slug>/` from SSSB's starter, renamed as
`pnpm create @sssb` renames your first app (its slug, session cookie, package names, seam package and display name,
`--name "<Name>"`), taking each `@sssb` package as your first app takes it, on a port slot of its own (named for the
slug, its default the first free one from 3700 up; `--slot <name>` and `--port <port>` choose them), with scripts and a
Playwright config that read that slot, and names it in the root's `sssb.apps`. It prints what is left to you: the
root's `dev`, `tick` and `start` scripts and the CI workflow's `synth`, which name one app on purpose. The starter comes
from the `@sssb/create` installed at the workspace root, which exports the code as `@sssb/create/add-app`; no SSSB
package depends on another, so the command says how to install it when it is missing.

**To adopt.** Nothing to do. For a second app: `pnpm add -D -w @sssb/create@<your @sssb version>`, then
`pnpm exec sssb add-app <slug>`, `pnpm install` and `pnpm exec sssb doctor`, which names anything the workspace still
needs (a Vitest config that keeps its own list of apps, the new app's `knip.json` entries, a root `@sssb/create` knip
would call unused: remove it once your apps are written). `pnpm jscpd` fails while the new app is still the starter;
make the apps your own, or ignore `apps/<slug>/src/**` in `.jscpd.json` until you have.
