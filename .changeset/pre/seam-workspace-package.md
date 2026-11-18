---
'@sssb/kit': minor
'@sssb/tools': minor
'@sssb/cdk': minor
'@sssb/create': minor
---

### The seam is a workspace package, so `pnpm add` keeps it linked

**Kind.** seam

**Action.** required

**What changed.** An app's seam declared as `"@sssb/app-config": "link:./src/app-config"` is unlinked from the app's
`@sssb/kit` by the next partial install for the app, `pnpm add <pkg>`, `pnpm remove <pkg>` or `pnpm update <pkg>`,
whether run from the root with `--filter` or in the app's directory: `sssb doctor` then fails ("runs on a seam not its
own") and typecheck fails inside the kit, and `pnpm install` does not bring it back. The seam is now a workspace
package with a name of its own, which the app takes under the name the framework imports, and pnpm keeps that linked.
`sssb doctor` fails an app that still declares its seam as a `link:`, even while it is linked, and says what to
change; it also fails an app whose declared seam is another app's, and one whose `workspace:` seam names no workspace
package, or more than one (an adopter who skips step 1 sees this).
The conformance suite's `seam-map` check holds the seam's `package.json` to the name the app declares it by. A
workspace `pnpm create @sssb` writes has the new form, and the plugin's commands say `pnpm --filter <app> add <pkg>`
again.

**To adopt.** For each app (`apps/<app>`, whose `package.json` name is `<name>`):

1. In `pnpm-workspace.yaml`, add the seams to `packages`: `- apps/*/src/app-config`, or each app's
   `apps/<app>/src/app-config`.
2. In `apps/<app>/src/app-config/package.json`, change `"name": "@sssb/app-config"` to `"name": "<name>-app-config"`
   (any name no other package of the workspace has; leave `exports` and `type` as they are).
3. In `apps/<app>/package.json`, change `"@sssb/app-config": "link:./src/app-config"` to
   `"@sssb/app-config": "workspace:<name>-app-config@*"`.
4. Run `pnpm install` and commit `pnpm-lock.yaml`, then `pnpm sssb:doctor` (or
   `pnpm exec sssb doctor --app apps/<app>`). This also repairs a seam a
   `pnpm add` already unlinked; no clean install is needed.
5. If your `knip.json` lists `src/app-config/**` among an app's entries, knip now counts those files as the seam's own
   workspace: move them to `"apps/<app>/src/app-config": { "entry": ["**/*.ts"] }`.

**Now deletable.** Any rule or note telling authors to edit `package.json` by hand instead of running `pnpm add`, to
restore `pnpm-lock.yaml` after one, or to delete every `node_modules` and the lockfile to relink the seam.
