# The doc set

SSSB is maintained by SafeInsights, and it is not SafeInsights-specific. The guard is the universality test in
[development-approach.md](development-approach.md) ("What SSSB ships"): vendor code ships only if essentially every product built on SSSB will use it or it demonstrates a class of
integration SSSB does not yet teach, a component only if it encodes a framework invariant, and
everything else is a recipe.

Three kinds of document live in this repo, and the difference matters because it tells you what to trust.

- **Doctrine** — maintained and binding. Read it before building. If a doctrine doc contradicts the code,
  that is a bug in the doc and it gets fixed.
- **Records** — dated, append-only logs of decisions and lessons. Entries were true when written and are
  never rewritten; later entries supersede earlier ones. Useful; not authoritative about the present.
- **Future tasks** — `.claude/future-tasks/`, designed-but-unbuilt work, kept beside the other agent state
  rather than in the human doc set.

A guard enforces the first distinction: `tests/docs/doc-paths.test.ts` fails the build if a doctrine doc
cites a repo path that does not exist. Records are exempt — rewriting a dated entry to match today's tree
would be revisionist — so their paths are corrected opportunistically, never gated. Citations of SSSB's two
reference apps (`apps/showcase`, `apps/starter`) are checked while the app exists and pass in a tree without it,
where they name SSSB's app rather than the reader's (`sssb.docPaths.referenceApps` in the root `package.json`).

## Read this for X

By task. The list under Doctrine is by document.

| You are…                                     | Read first                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Adding a vendor adapter                      | `docs/development-approach.md`, "What SSSB ships", then [recipes/app-owned-adapter.md](recipes/app-owned-adapter.md) |
| Adding a generic UI component                | the same section's component test, then [recipes/list-kit.md](recipes/list-kit.md) as the worked case                |
| Adopting SSSB, or upgrading to a new release | [adopting.md](adopting.md)                                                                                           |
| Working out why a design is the way it is    | [adr/](adr/), then [development-approach.md](development-approach.md)                                                |
| Adding an auth capability                    | [auth-ui-playbook.md](auth-ui-playbook.md)                                                                           |
| Deciding whether SSSB should ship a thing    | [app-coverage-gaps.md](app-coverage-gaps.md)                                                                         |
| Cutting over to real credentials             | [cutover-checklist.md](cutover-checklist.md)                                                                         |
| Running or showing the demo                  | [runbooks/demo.md](runbooks/demo.md)                                                                                 |
| Releasing                                    | `.changeset/README.md`, and [runbooks/release-app.md](runbooks/release-app.md) (setting up the release App)          |
| Looking for what was decided without a plan  | [decision-log.md](decision-log.md)                                                                                   |
| Debugging something that behaves strangely   | [build-notes.md](build-notes.md)                                                                                     |
| Looking for designed-but-unbuilt work        | `.claude/future-tasks/index.md`                                                                                      |

## Doctrine

- [provenance.md](provenance.md) — where SSSB came from, why the framework was extracted rather than
  designed, and what deliberately is not in this repository
- [adopting.md](adopting.md) — starting a product on SSSB and upgrading it: the generator, what is yours and
  what is SSSB's, the seam, the starter's content to replace, cutover, releases
- [development-approach.md](development-approach.md) — the engineering philosophy: thin slices,
  ports/adapters, hermetic dev, demo mode, what SSSB ships
- [adr/](adr/) — the architecture decisions: 0001–0014 Accepted. Each body states the decision as it holds
  today; from here an ADR is amended by appending a **dated addendum**, never by editing what it said
- [auth-ui-playbook.md](auth-ui-playbook.md) — the recipe for adding auth capabilities (Clerk anatomy
  re-expressed in Mantine)
- [app-coverage-gaps.md](app-coverage-gaps.md) — the capability triage: what SSSB ships vs defers,
  and the doctrine for deciding the next case
- [recipes/](recipes/) — capabilities SSSB deliberately doesn't ship: vendor integrations
  (e-sign, SMS, web push, per-person cloud workspaces) and generic UI it has no invariant to encode (the list/table kit); copy one
  when an instance needs the capability
- [runbooks/](runbooks/) — [demo.md](runbooks/demo.md), the guided tour of everything the scaffold does,
  [deploy.md](runbooks/deploy.md), the deploy shape, [data-api.md](runbooks/data-api.md), the live proof
  that closes the RDS Data API driver's cutover row, and [release-app.md](runbooks/release-app.md), making the
  GitHub App that SSSB's own release workflow pushes with
- [cutover-checklist.md](cutover-checklist.md) — SSSB's own list of deferred credential-needing items and
  what unlocks each; a generated workspace gets a checklist of its own

## Records

- [decision-log.md](decision-log.md) — running log of unplanned decisions, appended as they happen
- [build-notes.md](build-notes.md) — running log of hard-won lessons ("wish someone had told me"). The
  most useful file in the repo when something behaves strangely
- docs/releases (a directory that appears with the first release) — one file per release, `v<version>.md`, written by `release.yml`'s `plan` job from the release's
  changesets (`.changeset/README.md`, "Release notes")

The records name branches, dates and slices from SSSB's own construction. That is what makes them
worth keeping — a lesson without its circumstances is a slogan — but it also means they describe a repo
that has moved on. When a record and a doctrine doc disagree about the present, the doctrine doc wins.
