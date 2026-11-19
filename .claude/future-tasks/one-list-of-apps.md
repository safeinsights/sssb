# One list of apps in a generated workspace, and `sssb add-app`

**Priority:** P2 · **Status:** open
**Found by:** the adoption review, 2026-11-18 (`docs/adoption-review-2026-11.md`, follow-up 3).

## What is true

A generated workspace names its app's directory in five root files: `package.json` (`sssb.apps`, and the `dev`,
`tick` and `start` scripts), `vitest.config.ts` and `vitest.contract.config.ts` (each an `APPS` list), `knip.json`
(a workspace entry for the app and one for its seam) and `.github/workflows/checks.yml` (`synth`). The scripts and the
workflow are right to name one app. The two `APPS` lists and knip's entries are a second and third copy of
`sssb.apps`, which `sssb doctor`, `sssb ci` and `sssb launch-json` already read. Adding a second app means finding
them; pages plans one.

## Design

- `@sssb/tools/vitest` gains a helper beside `appTestProject`, say `workspaceAppProjects({ root })`, that reads the
  root's `sssb.apps` (else `apps/*`, as `workspaceApps` in `packages/tools/src/app.js` does) and returns a project per
  app. Both generated Vitest configs call it; the contract config narrows each project as it does today.
- knip: either the generator keeps writing the entries and `sssb doctor` reports an app `sssb.apps` names that
  `knip.json` does not, or knip's config becomes a `knip.config.ts` that builds its workspaces from the same list.
  Prefer the report: a TypeScript knip config is one more thing to run.
- A "Scaffold changes to apply by hand" changeset, Action `optional`: a workspace that keeps its `APPS` lists keeps
  working.

## Done when

A second app in a generated workspace is added by creating it and naming it in `sssb.apps`, plus its port slot, and
`sssb doctor` names anything else left to do.

## And a command that adds the app

Even with one list, nothing writes the second app: `@sssb/create` writes a whole workspace into an empty directory. A
command (`sssb add-app <slug>`, or `pnpm create @sssb --app <slug>` inside a workspace) would write `apps/<slug>` from
the generator's template, name it in `sssb.apps`, give it a port slot of its own and print the root scripts to point
at it. It is what proves the `apps/` layout's one benefit, a cheap sibling, and pages needs it for its second app. The
generator's rename code is the starting point; pack and consume's `pages` shape, which already adds a second generated
app by hand, is the gate.
