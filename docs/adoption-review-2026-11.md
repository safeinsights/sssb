# Adoption review, November 2026

A dated assessment, made on `int-p14` after P14 (the first npm release) merged into it: how simple adopting SSSB is,
whether a one-app workspace should keep its app under `apps/<app>/`, and what would make adoption simpler, ranked.
It is a record: what it measured was true on 2026-11-18, and each follow-up it names is tracked where it says.

## How it was measured

A workspace was generated the way a contributor tries an unreleased commit (`docs/adopting.md`, "Trying an
unreleased commit of SSSB"): the four packages packed from the branch, then
`node packages/create/bin/create.js acme --sssb <tarballs> --name "Acme Research" --repo acme-org/acme-research --owner @acme-org/devs`.
It was then walked as a newcomer would, reading only the generated files and SSSB's public docs.

| Step                                                                                                   | Result                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Generate                                                                                               | 97 files, about 2 seconds, no network                        |
| `git init`, `pnpm install`                                                                             | 33 seconds on a warm pnpm store                              |
| `typecheck`, `lint`, `test:unit`, `sssb:doctor`, `knip`, `jscpd`, `check:fences`, `check:e2e`, `synth` | all green, about 70 seconds run one after another            |
| `test:contract` (embedded Postgres)                                                                    | green, 28 seconds                                            |
| `test:e2e` and the static demo's                                                                       | not run here; CI's `adoption-probe` runs the whole `verify`  |
| `sssb doctor`                                                                                          | `ok`, with both pins on the kit's release commit and no gaps |

So the mechanical half is in good shape: one command, one install, and a gate that is green on the first run. What
an adopter meets before a first change of their own is mostly reading.

## What a newcomer meets

**Concepts before the first green `pnpm verify`.** Four: the workspace and its app under `apps/<app>/`; the seam
(`apps/<app>/src/app-config/`), the one door from the framework into the app; SSSB's four packages, which they never
edit; and two pins to one commit of SSSB's repository (the CI workflow and the Claude Code plugin). `sssb doctor`
reports on all four, so a newcomer can lean on it rather than learn them up front.

**Concepts before a first change of their own.** The starter's content is on screen and has to be replaced by hand
(its seed world, its welcome copy, its Items slice, about fifteen files); a new slice touches about a dozen files
(screen, route, ability, table, migration, RLS proof, two catalogs, the static demo's composition root, an e2e spec),
which `/sssb:new-slice` walks.

**What surprised.**

1. **The Simulator, the README's first selling point, is not on a generated app's `pnpm dev`.** The panel, its tabs and
   presets and tours are in the app's single-file static demo, but the server-side panel needs about 870 lines of glue
   and 33 route files that only the showcase carries (`.claude/future-tasks/starter-starting-points.md`). Until this
   review, the README and `docs/adopting.md` ("First boot") implied otherwise; both now say it.
2. **`docs/adopting.md` is about 840 lines**, and before this review its first section after the quick start was how
   to pack tarballs from a checkout of SSSB. A newcomer needs perhaps 150 of those lines; the rest (what the generator
   refuses, how `sssb doctor` lists Vitest's tests, the knip settings, the dev ticker) is reference. This review moved
   the checkout section to the end and added a five-step reading path at the top; the split is follow-up 2.
3. **The generated README pointed nowhere.** It never said where SSSB's guide or the showcase are. It now links both,
   at the commit the workspace pins.
4. **"Starter" in an app called `acme`**: its port slot, `originFor('starter')`, `sssb tick starter`. Correct, and
   explained in a paragraph of `docs/adopting.md`, but it reads like a leftover (follow-up 5).
5. **The app's directory is named in five root files**: `package.json` (`sssb.apps` and the `dev`, `tick` and `start`
   scripts), both Vitest configs (`APPS`), `knip.json` and the CI workflow (`synth`). Adding a second app means
   finding all five (follow-up 4).
6. **Settings only the adopter can make**, three on GitHub (require `sssb / all-checks`, private vulnerability
   reporting, and, for a private repository in an organization, public reusable workflows) and one per clone
   (`claude plugin install sssb@sssb --scope project`, on Claude Code 2.1.324 or later). The generator prints the
   first two and the README lists all of them; nothing here can be automated without a token SSSB should not ask for.

**What is ceremony, and is not worth removing.** The pinned workflow and plugin, the stamped guide copy, the
conformance suite and the contract runner each guard a failure that happened (ADR-0014's record). Each costs the
adopter nothing until a release, and `sssb doctor` names what is out of step.

## `apps/<app>/` in a one-app workspace

JP's question: does it seem weird that a workspace with one app, the adopting app, keeps it under `apps/<app>/`?

**Why it is there.** The workspace has at least three packages per app whatever the layout: the app, its seam
(`apps/<app>/src/app-config`, a workspace package so that pnpm keeps it linked into the app's `@sssb/kit`) and its
deployment (`apps/<app>/infra`, a CDK app with its own dependencies). So the choice is not "a workspace or a plain
app" but where the app sits inside a workspace. ADR-0007 put apps in `apps/` so that a second app is a sibling, not a
special case; the root's commands fan out over `apps/*`, so they mean the same with one app or several; and the
workspace root is `<slug>-workspace`, never the app's name, so `pnpm --filter <slug>` matches the app alone.

**Who it serves today.** Pages, the first adopter, is a workspace with an app (apps/console), two packages of its
own (packages/gate, packages/cli) and an infra/ directory, and port slots (`docs/adopting.md`, "A workspace with two apps gives each its own
slot") just merged so that it can add a second app. For pages, `apps/` is the natural shape, not overhead.

**The alternatives.**

| Layout                                                                                                                | What it buys                                                                               | What it costs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. The app at the workspace root** (the root package is the app; its seam and its infra/ nested workspace packages) | Paths one segment shorter (src/… for apps/acme/src/…); no `--filter` in the root's scripts | A second layout that every tool keeps forever, because pages stays on `apps/`: the generator and its tests, the Vitest and ESLint presets (the root's own config and the app's become one, so the fences reach the root's tool configs), `sssb doctor`'s workspace walk, `sssb ci`'s fan-out, `sssb launch-json`, the plugin's `sssb.apps` addressing, knip's and jscpd's patterns, a third pack-and-consume shape, and every `apps/<app>/` in the docs. The root `package.json` mixes the app's dependencies with the workspace's tools. A second app later is a move. |
| **B. The workspace with the app at `app/`**                                                                           | One segment shorter than `apps/<slug>/`, and no slug in paths                              | Most of A's tool changes, with none of its benefit for a second app: app/ beside apps/ledger/ is the special case ADR-0007 exists to avoid.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **C. Keep `apps/<app>/` and say why** (built in this review)                                                          | Nothing moves; pages is untouched; one layout for every tool                               | The extra segment, which root scripts already hide: `pnpm dev`, `pnpm verify` and the rest run from the root.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Recommendation: C**, with follow-up 4 so that a second app is one edit. The cost of `apps/<app>/` is one path
segment; the commands an adopter types are root scripts that never name it, and the guide's paths are already
relative to the app. Moving it would make SSSB carry two layouts for the life of the project, for a cosmetic gain, and
would change nothing for the adopter SSSB actually has. The generated README, SSSB's README and `docs/adopting.md`
("What is yours, and what is SSSB's") now say in one sentence why the app sits there.

## What else would make adoption simpler, ranked

Ranked by value to a new adopter against cost, and against churn for pages. None of these changes the layout of a
generated workspace or moves an adopter's files.

| #   | Change                                                                                                                                                                                                                                                                                           | Value                                                                                        | Cost                                                                               | Churn for pages                                                        | Tracked in                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | **The Simulator on a generated app's `pnpm dev`.** Ship the panel's server glue and its routes from `@sssb/kit` as handler factories, so an app mounts them with a handful of thin route files, and the starter carries them.                                                                    | High: it is the README's first claim, and every adopter wants it in dev                      | High: framework work, about 870 lines of glue and 33 routes to turn into factories | None required; pages may delete its own glue when it takes the release | `.claude/future-tasks/starter-starting-points.md`     |
| 2   | **Split `docs/adopting.md`** into a guide of about 150 lines (generate, boot, replace the starter's content, first slice, cutover, upgrade) and a reference holding the rest, each section kept whole.                                                                                           | High: it is the first doc every adopter reads                                                | Low: docs only, but every link to a moved section is repointed                     | None                                                                   | `.claude/future-tasks/adopting-guide-split.md`        |
| 3   | **Remove the starter's content in one step**: a `--blank` option, or a command, that takes out the Items slice and leaves an empty dashboard.                                                                                                                                                    | Medium: today it is a fifteen-file hand sweep, and an adopter once shipped a demo with it in | Medium: generator work, and a second starter shape the gates must keep green       | None                                                                   | `.claude/future-tasks/create-blank-option.md`         |
| 4   | **One list of apps.** The Vitest configs read `sssb.apps` (a helper beside `appTestProject` in `@sssb/tools/vitest`), so a second app is added in `package.json` alone, plus knip's workspace entry.                                                                                             | Medium, and soon: pages plans a second app                                                   | Low: one helper, the generator's two configs, and a "Scaffold changes" entry       | Optional: pages may switch its configs to the helper                   | `.claude/future-tasks/one-list-of-apps.md`            |
| 5   | **No `starter` in a generated app.** Since port slots merged, `originForApp(__dirname)` and `sssb tick` / `sssb dev-tick` with no slot read the app's own declaration, so the starter can stop naming its slot anywhere but its `package.json`; the neutral slot name then removes the last one. | Low to medium: removes a surprise and a paragraph of explanation                             | Low                                                                                | None: a workspace that keeps `starter` keeps working                   | `.claude/future-tasks/neutral-app-port-service.md`    |
| 6   | **A hosted single-file demo of the showcase**, attached to each release, linked from the README, so an evaluator sees the product without cloning.                                                                                                                                               | Medium for evaluators, none for adopters                                                     | Low, but it touches the release workflow                                           | None                                                                   | `.claude/future-tasks/hosted-showcase-demo.md`        |
| 7   | **`AppSubjectFields` without a lint suppression**, so an empty registration is free in all twelve seam modules.                                                                                                                                                                                  | Low                                                                                          | Low                                                                                | None                                                                   | `.claude/future-tasks/empty-registration-friction.md` |

Smaller things this review fixed instead of listing: "the template" meaning SSSB itself throughout the doctrine docs
(the generator's template is `apps/starter`, so the phrase now names only that), the README's "It is not a library"
heading, SSSB's cutover checklist calling itself the reader's, the changeset README's description of adoption as a
fork, the generator's printed next steps leaving out `pnpm dev`, and the generated README's missing links. Each is in
`docs/decision-log.md` (2026-11-18, "Adoption wording review").
