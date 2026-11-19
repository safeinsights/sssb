# Adoption review, November 2026

A dated assessment, made on `int-p14` after P14 (the first npm release) merged into it: how simple adopting SSSB is,
whether a one-app workspace should keep its app under `apps/<app>/`, and what would make adoption simpler, ranked.
It is a record: what it measured was true on 2026-11-18, and each follow-up it names is tracked where it says.

## How it was measured

A workspace was generated the way a contributor tries an unreleased commit (`docs/adopting.md`, "Trying an
unreleased commit of SSSB"): the four packages packed from the branch, then
`node packages/create/bin/create.js acme --sssb <tarballs> --name "Acme Research" --repo acme-org/acme-research --owner @acme-org/devs`.
A reviewer playing a developer new to SSSB then walked a second one, reading only the generated files and SSSB's
public docs (`README.md`, `docs/adopting.md`, `docs/README.md`, `CONTRIBUTING.md` and what they link), as far as
planning a first change of its own: replacing the starter's Items slice with a Projects entity.

| Step                                                                                                   | Result                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Generate                                                                                               | 97 files, about 2 seconds, no network                         |
| `pnpm install`                                                                                         | 33 seconds on a warm pnpm store; 86 seconds in the second run |
| `typecheck`, `lint`, `test:unit`, `sssb:doctor`, `knip`, `jscpd`, `check:fences`, `check:e2e`, `synth` | all green, about 70 seconds run one after another             |
| `test:contract` (embedded Postgres)                                                                    | green, 28 seconds                                             |
| `sssb doctor`                                                                                          | `ok`, with both pins on the kit's release commit and no gaps  |

**Not walked**: the npm path itself (`pnpm create @sssb` from the registry: 0.2.0 was not yet published), `pnpm dev`,
the e2e suites (CI's `adoption-probe` runs the whole `pnpm verify` on a generated workspace on every PR), and a first
change actually made. The counts below of files touched by that change are the reviewer's, from the tree, not timed.

So the mechanical half is in good shape: one command, one install, and a gate that is green on the first run. What an
adopter meets before a first change of their own is mostly reading, and that is where the cost is.

## What a newcomer meets

**Concepts.** The newcomer counted about seventeen before a confident first change, and judged about eight of them
unneeded that early: the gates beyond "run `pnpm verify`", the pins, port slots, the cutover checklist, the scheduled
tick, the Postgres floor, the generator's refusal rules, and SSSB's fork and release history. The essential reading was
about 150 of `docs/adopting.md`'s 840 lines. The starter's own code comments (the items route, its migration, the RLS
proofs, `abilities.ts`, the static demo's composition root) taught faster than the docs.

**The first change.** Replacing Items with a first entity touches about a dozen files: the seed and `staffOrgSlug`,
the ability, the table type, a migration and its index, the RLS proofs, a route, a card, the dashboard's glue, two
catalogs and `APP_NAMESPACES`, the static demo's composition root, two specs. `/sssb:new-slice` walks it; the docs
cover about 80% of it for someone not using Claude Code.

**What surprised**, most costly first.

1. **The app guide's worked examples were the files the adoption guide says to delete.** `.claude/sssb-guide.md` cited
   `1001_items.ts` and `api/items/route.ts` as the patterns to copy, the copy may not be edited, and the adoption
   guide's "then remove Items the way 'To remove a slice' below describes" deletes both. Fixed here: the guide says where to read them once removed.
2. **The example to copy breaks a rule.** The items route's GET returns an unbounded list, while the guide requires
   keyset paging for a list that can grow; the only paged example is the showcase's. Follow-up 9.
3. **The Simulator, the README's first selling point, is not on a generated app's `pnpm dev`.** The panel, its presets
   and tours are in the app's single-file static demo, but the server-side panel needs about 870 lines of glue and 33
   route files that only the showcase carries. The README and `docs/adopting.md` ("First boot") implied otherwise
   until this review; both now say it.
4. **`docs/adopting.md` is about 840 lines**, and the section a first change needs most ("The starter's content is
   still wired into your UI") sits under the generator's reference, after its refusal rules. This review added a
   reading path at the top and moved "Trying an unreleased commit of SSSB" to the end; the split is follow-up 1.
5. **History and internals on the newcomer's path**: the opening paragraph said what adoption is not (a fork),
   several passages tell how a rule came to be, and pointers lead into SSSB's `.claude/future-tasks/` and its source.
   The opening is fixed; the rest moves to the reference in follow-up 1.
6. **The generated app called itself a template**, on its welcome screen and in comments, its infra tags said
   `TEMPLATE-UPDATE-ME` with nothing telling the adopter to replace them, and the generated README pointed nowhere.
   All fixed here: the README now links SSSB's guide and the showcase at the pinned commit and names the tags.
7. **"starter" in an app called `acme`**: its port slot, `originFor('starter')`, `sssb tick starter`. Correct and
   explained, but it, more than the directory, made the newcomer's app feel like someone else's. Follow-up 5.
8. **Tenant, organization and team are never defined** on the newcomer's path, and a first entity has to choose
   between tenant-scoped RLS with an organization filter (as Items does) and something else. Follow-up 1.
9. **The first install warns about peers**: eslint 10 against `eslint-plugin-react` and `eslint-plugin-jsx-a11y`,
   which declare eslint 9 at most. Nothing says it is expected. Follow-up 9.
10. **The app's directory is named in five root files**: `package.json` (`sssb.apps` and the `dev`, `tick` and
    `start` scripts), both Vitest configs (`APPS`), `knip.json` and the CI workflow (`synth`). The scripts and the
    workflow are right to name one app; the two `APPS` lists and knip's entries are copies of `sssb.apps`. Follow-up 3.
11. **Settings only the adopter can make**: three on GitHub (require `sssb / all-checks`, private vulnerability
    reporting, and for a private repository in an organization, public reusable workflows) and one per clone
    (`claude plugin install sssb@sssb --scope project`, on Claude Code 2.1.324 or later). Follow-up 8.

**Ceremony, examined.** The conformance suite and the contract runner guard failures that happened (ADR-0014's
record) and cost nothing between releases: keep. Two others cost something at every upgrade:

- **The stamped guide copy** (`sssb guide`, refreshed and reviewed per release). Importing the kit's guide straight
  from `node_modules` would remove the copy, the stamp, a doctor check and a command, and it is rejected on purpose:
  agent instructions steer every agent in the repository, so ADR-0014 part 9 makes a change to them arrive as a diff
  in the adopter's own PR, never silently through an install. Keep, and say why where the adopter meets it.
- **Two pins to one commit** (the workflow's `uses:` and the plugin marketplace's `ref`), which the adopter edits by
  hand each release while `sssb doctor` reconciles them with the kit's stamp. The installed kit already knows the
  commit (`dist/release.json`), so a command could raise both. Follow-up 7.

## `apps/<app>/` in a one-app workspace

JP's question: does it seem odd that a workspace with one app, the adopting app, keeps it under `apps/<app>/`?

**What ADR-0007 said, and why it is still the answer.** ADR-0007 opens by granting that for a single product "the
Next app at the repo root" is the natural shape, and chose `apps/` for SSSB's own repository, whose two apps exist to
falsify the framework. It put an adopter's one app under `apps/` only as what the fork era's eject left behind. What decides it now is that a generated workspace is a
workspace whatever its layout: the app, its seam (`apps/<app>/src/app-config`, a workspace package so that pnpm keeps
it linked into the app's `@sssb/kit`) and its deployment (`apps/<app>/infra`, a CDK app with its own dependencies,
moved into the app by ADR-0014's D8 so the root names no app) are three packages. So the choice is not "a workspace or
a plain app" but where the app sits inside one, and the root package cannot be both the workspace's tooling,
`<slug>-workspace`, and the app.

**What the tools already allow.** `sssb`'s commands do not assume `apps/`: `packages/tools/src/app.js` treats a
workspace whose apps live elsewhere, or a single-app repository, as first-class, `sssb.apps` names the apps for
`sssb doctor`, `sssb ci`, `sssb launch-json` and the plugin, and doctor handles a root-level app with packages nested
under it. So a different layout would cost the generator and what it writes, not the CLI.

**Who it serves today.** Pages, the one adopter, is a workspace with an app (apps/console), two packages of its own
(packages/gate, packages/cli) and an infra/ directory, and port slots just merged so it can add a second app. That is
one data point, and it was shaped by the fork era; it says nothing about an adopter with one app and no packages, of
whom there are none yet to ask.

**The alternatives.**

| Layout                                                                                             | What it buys                                                                  | What it costs                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. The app at the workspace root** (the root package is the app; its seam and its infra/ nested) | One segment fewer in every path you read; no `--filter` in the root's scripts | The root package becomes both the app and the workspace's tooling, so its dependencies mix; the app's lint preset and the root's own config become one file, so the fences reach the root's tool configs; the generator, its tests and the knip, jscpd and Vitest configs it writes change shape; a third pack-and-consume shape; every `apps/<app>/` in the docs. A second app later is a move. |
| **B. The app at `app/`**                                                                           | One segment shorter than `apps/<slug>/`, and no slug in paths                 | The generator's paths, its tests and a pack-and-consume shape. A second app makes app/ beside apps/ledger/ the special case, and the app's router directory becomes `app/src/app/`.                                                                                                                                                                                                              |
| **C. A fixed name, apps/web/**                                                                     | No slug in paths, so the docs and the plugin can say literal paths            | The same generator change as B, and a second app then wants a real name for the first; the slug still names the package, the cookie and the database.                                                                                                                                                                                                                                            |
| **D. A generator flag choosing A or `apps/`**                                                      | The adopter chooses                                                           | Both layouts, every gate run in both: the cost of A, doubled.                                                                                                                                                                                                                                                                                                                                    |
| **E. A symlink at the root to the app**                                                            | Short paths in an editor                                                      | Tools resolve real paths (`packages/tools/src/kit.js` checks one), and links are poor on Windows.                                                                                                                                                                                                                                                                                                |
| **F. Keep `apps/<app>/`, say why, and make it invisible** (built in part here)                     | Nothing moves; one shape for every adopter, pages included                    | One segment in every path you read, none in a command you type (the root's scripts never name it).                                                                                                                                                                                                                                                                                               |

**Recommendation: F.** The gain from moving is one path segment; the cost is a generator and a set of gates carrying
a second layout, or a one-time move for pages, for a benefit no adopter has asked for. The newcomer found the
directory mildly odd and then well explained; what made the app feel like someone else's was `starter`, not `apps/`.
The generated README, SSSB's README and `docs/adopting.md` now say in one sentence why the app sits there. To make it
invisible as well, follow-up 3 makes a second app one entry and adds `sssb add-app`, the step that would actually prove
the shape's one benefit, and follow-up 5 removes `starter`.

## What else would make adoption simpler, ranked

Ranked by value to a new adopter against cost. None changes the layout of a generated workspace or moves an adopter's
files; where pages would have something to do, the last column says so.

| #   | Change                                                                                                                                                                                                                                                                                      | Value                                                                 | Cost                                                                    | For pages                                  | Tracked in                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| 1   | **Split `docs/adopting.md`** into a guide of about 150 lines (generate, boot, replace the starter's content, a first entity walked file by file with tenant and organization defined, cutover, upgrade) and a reference holding the rest.                                                   | High: every adopter's first read                                      | Low: docs only, with every link to a moved section repointed            | nothing                                    | `.claude/future-tasks/adopting-guide-split.md`     |
| 2   | **Remove the starter's content in one step**: a command (or a plugin command) that takes out the Items slice, tested once against the starter, rather than a `--blank` flag and a second starter shape the gates keep green.                                                                | High: the first thing every adopter does, and once shipped by mistake | Medium                                                                  | nothing                                    | `.claude/future-tasks/create-blank-option.md`      |
| 3   | **One list of apps, and `sssb add-app`.** The Vitest configs read `sssb.apps`, doctor reports a knip gap, and a command writes a second app from the starter into an existing workspace, names it in `sssb.apps` and gives it a port slot.                                                  | Medium now, high for pages' second app                                | Low for the list; medium for the command                                | optional: switch its configs to the helper | `.claude/future-tasks/one-list-of-apps.md`         |
| 4   | **A hosted single-file demo of the showcase**, attached to each release and linked from the README: until 6 lands, the only way to see the Simulator without cloning SSSB.                                                                                                                  | Medium, for evaluators and new adopters                               | Low, but it touches the release workflow                                | nothing                                    | done: `.claude/future-tasks/resolved/`             |
| 5   | **No `starter` in a generated app.** Since port slots merged, `originForApp(__dirname)` and `sssb tick` / `sssb dev-tick` with no slot read the app's own declaration, so the starter can name its slot only in its `package.json`; a neutral slot name removes that too.                   | Medium: the newcomer's main "not mine" signal                         | Low                                                                     | nothing: `starter` keeps working           | `.claude/future-tasks/neutral-app-port-service.md` |
| 6   | **The Simulator on a generated app's `pnpm dev`, in stages.** Ship the panel's server glue from `@sssb/kit` behind one catch-all route an app mounts with a single file, rather than 33 thin routes; start with the tabs a new app uses first (people, jobs and the clock, the mail inbox). | High: the README's first claim                                        | High: framework surface, authorization exemptions, the public `exports` | optional: delete its own glue              | `.claude/future-tasks/starter-starting-points.md`  |
| 7   | **Raise both pins in one command** on upgrade, from the installed kit's release commit, so an adopter maintains one version, the npm one.                                                                                                                                                   | Medium: a hand edit every release                                     | Low                                                                     | optional                                   | this review                                        |
| 8   | **The adopter's own settings, reported**: `sssb doctor` reports, when `gh` is signed in, whether `sssb / all-checks` is required and private vulnerability reporting is on, and whether the plugin the workspace enables is installed. Changing a setting stays the adopter's.              | Low to medium                                                         | Low                                                                     | nothing                                    | this review                                        |
| 9   | **Small starter fixes**: keyset paging in the items route, so the example obeys the guide; the eslint 10 peer warning on first install, fixed or explained; an empty `AppSubjectFields` without a lint suppression (`.claude/future-tasks/empty-registration-friction.md`).                 | Low to medium                                                         | Low                                                                     | nothing                                    | this review                                        |

Smaller things this review fixed instead of listing: "the template" meaning SSSB itself in the doctrine docs,
`SECURITY.md`, a maintainer command and the issue templates (the generator's template is `apps/starter`, so the phrase
now names only that there; a few open future tasks keep the fork era's "an app derived from this template" as
provenance), the README's "It is not a library"
heading, SSSB's cutover checklist calling itself the reader's, the changeset README's description of adoption as a
fork, the generator's printed next steps leaving out `pnpm dev`, the generated README's missing links, the guide's
worked examples, the generated app's template wording and tags, and a few contradictions in `docs/adopting.md` (a
section named wrongly, "until SSSB's first npm release", the migration number for a first table). Each is in
`docs/decision-log.md` (2026-11-18, "Adoption wording review").
