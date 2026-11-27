# SSSB — a foundation for multi-tenant web applications

A production-shaped Next.js foundation you generate a workspace from and build a product on: ports-and-adapters
architecture, Postgres row-level-security tenancy, and a local development loop that runs the whole world on your
laptop with no docker, no credentials, and no network.

To see it with nothing to install, download the showcase as one HTML file from the latest release,
[`sssb-showcase.html`](https://github.com/safeinsights/sssb/releases/latest/download/sssb-showcase.html), and open it in
a browser: it runs from `file://`, the Simulator and its tours included. Every release after 0.2.0 carries it;
`pnpm build:demo-static` in `apps/showcase` builds it from a checkout, as `dist-demo/index.html`.

To run the whole of it, clone this repository and run:

```sh
pnpm install
pnpm dev
```

That is the entire setup. It boots the showcase, SSSB's worked example app, in seconds against fake adapters —
in-process Postgres, a person picker instead of a hosted IdP, caught email in a dev mailbox, deterministic canned
model replies — with two seeded tenants and six people already in the world. **Fresh clone to running app in under
two minutes is a standing acceptance test**, here and in every workspace the generator writes, not an aspiration.
To build a product on SSSB, you generate a workspace of your own instead ("Starting a product on it", below).

Prerequisites: Node ≥ 24 (`.nvmrc` pins it), pnpm ≥ 11, and — once, before `pnpm verify` —
`pnpm exec playwright install chromium`.

## Two things here are unusual

Ports and adapters with fakes behind them is table stakes; the pattern is twenty years old and you have
seen it. These two are the reason this repo exists.

### 1. The world around the app is simulated, inhabited, and drivable

A fake stubs what your app calls **out** to. That leaves a world that stands still: nothing calls back in,
so an async workflow sits at `queued` with nobody to advance it, and the only way to watch your app behave
like production is to go get production.

Here the fakes compose into a world with inhabitants, and a panel called **Simulator** to drive it:

- **Other people**, each with their own inbox and their own last-known location. Click one and you are
  them, restored to where they were — including people who were invited but never signed up, whose mail
  you can read before they have an account.
- **Counterparties that act on their own.** Simulated external services run as independent processes and
  talk to your app only over the surfaces a real one would — genuine HTTP polls and signed webhooks, never
  an in-process shortcut. Pause one, or step it a single call at a time.
- **A clock you can push forward.** Jump an hour, a day, a week, and watch the scheduled work that came
  due actually fire.
- **A world you can snapshot and restore**, plus demo presets that load the same starting point in the
  static demo too, so a demo starts from the same state every time.
- **Walkthroughs that drive themselves.** A _tour_ is the temporal sibling of a snapshot: it restores one
  (or a demo preset), then drives the real screens with a ghost cursor while a bar narrates. Nothing is submitted until the
  person watching presses Next, and every registered tour is run to its last step in CI, so a screen change
  that breaks the story fails the build instead of embarrassing you in front of a stakeholder.

You can hold every job in the world at `queued` and watch the choreography, then let them complete inline
again. None of this reaches production: real builds ship zero Simulator client code.

In the showcase all of it runs on `pnpm dev`. An app the generator writes has the whole Simulator in its single-file
static demo from the start, and on its own `pnpm dev` the People, Mail, Jobs (with the world clock) and Snapshots tabs,
its demo presets and its tours, served by SSSB behind one route file; the Events, Messages, Hooks, Errors and Actors
tabs follow in stages ([safeinsights/sssb#128](https://github.com/safeinsights/sssb/issues/128) and
[safeinsights/sssb#152](https://github.com/safeinsights/sssb/issues/152)).

### 2. The boundaries are enforced by the build, not by documentation

Every architectural rule here is a check that fails, because a rule that lives only in a document is a rule
that erodes on the first busy Friday:

| Rule                                      | What stops you                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Vendor SDKs only inside adapters          | lint (`sssb/no-vendor-import`, and `sssb/no-dynamic-vendor-import` for `import()`) |
| No untenanted database access in app code | lint bans raw `getDb()` (`sssb/no-raw-db-handle`, deny-by-default)                 |
| Every mutating route authorizes           | a build-time scan walks the routes and fails any that don't                        |
| Tenant isolation actually isolates        | one RLS proof suite, run against both the in-process engine and real Postgres      |
| The framework never reaches into your app | a package fence — one registration seam is the only door                           |
| No hard-coded UI strings                  | lint, plus a test that both locale catalogs stay key-identical                     |
| Docs don't lie about paths                | a test fails if a doctrine doc cites a path that doesn't exist                     |
| Dead code                                 | `knip` fails the build                                                             |

One command runs all of it: `pnpm verify`.

## Modes and scripts

| Command                  | What it is                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`               | Hermetic dev: all fake adapters, seeded, offline                                                                                     |
| `pnpm dev:real`          | Real adapters against cloud resources — fails fast, listing missing cutover items                                                    |
| `pnpm tick`              | Tick the running dev server's scheduler once (`DEV_TICK_SECONDS=30 pnpm dev` or the Simulator's Jobs tab does it on a timer, opt-in) |
| `pnpm verify`            | The gate: typecheck + lint + unit + e2e + static-demo build + `file://` walkthrough                                                  |
| `pnpm test:contract`     | The same RLS proofs on **real Postgres**, for each app (in a database of its own) and for SSSB's own fixture                         |
| `pnpm build:demo`        | Demo build (fake adapters, demo badge); `pnpm start:demo` serves it                                                                  |
| `pnpm build:demo-static` | Single-file demo (`dist-demo/index.html`) that runs from `file://`                                                                   |
| `pnpm ladle`             | Component workshop (screens + email templates)                                                                                       |

That last build deserves a note. `dist-demo/index.html` is **one HTML file with no server** — the same
screens over in-memory fakes, Simulator included. You can email it to someone and they can click through
the whole product from disk, or press **Simulator → Tours → Start** and be walked through it. It is also the most demanding proof that the ports boundary really holds: if
anything reached past a port, it could not build.

**Demoing it.** Two clicks get you into the story, on `pnpm dev` and in the single-file demo alike.
**Simulator → Snapshots → Start from a preset → Load** resets the world to a scripted starting point and
signs you in as the right person; **Simulator → Tours → Start** hands the wheel to a narrated walkthrough,
which may itself begin from a preset. [docs/runbooks/demo.md](docs/runbooks/demo.md) is the story to tell;
`/sssb:new-preset` and `/sssb:new-tour` (SSSB's Claude Code plugin) are how you write your own.

## Architecture in one paragraph

Vendor SDKs live only in [packages/kit/src/adapters/](packages/kit/src/adapters/), or, for a vendor
SSSB has no port for, in an app's own `apps/<app>/src/adapters/real/`
([recipe](docs/recipes/app-owned-adapter.md)), and both are lint-enforced. Everything else codes against
the narrow interfaces in [packages/kit/src/ports/](packages/kit/src/ports/)
(`auth`, `db`, `storage`, `llm`, `email`, `analytics`, `jobs`) or an app's own port. Domain logic is pure TypeScript in
[packages/kit/src/core/](packages/kit/src/core/). Screens are router-agnostic — which is what makes the
`file://` demo possible — and route files are thin wrappers. Tenancy is enforced _in the database_ by
row-level security: every tenant-scoped query runs inside `withTenant()`. Inside a tenant, `authorize()` is
the single choke point for resource-level decisions. All UI copy flows through next-intl (`en` + `es`).

## Starting a product on it

Read **[docs/adopting.md](docs/adopting.md)**. The short version: the framework is `@sssb/kit` (`packages/kit`
here), your app extends it only through the `apps/<app>/src/app-config/` registration seam, and a capability you don't
want is turned off by registering nothing for it.

```sh
pnpm create @sssb acme --name "Acme Research" --repo acme-org/acme-research --owner @acme-org/devs
```

That writes a new workspace in `acme/`: your app in apps/acme/, generated from `apps/starter` and renamed, with its
root config, its CI (a workflow calling SSSB's reusable one), its owner files and SSSB's packages as dependencies —
the whole mechanical half of adoption. The app sits under `apps/` so that a second app or a package of your own is a
sibling rather than a special case; one app is the usual shape.

Two example apps ship here: `apps/showcase` (a support desk — tickets, escalations, file attachments, an export job
run by a simulated external service) so every framework capability has a living worked example, and `apps/starter`, the template the generator copies. Build against the showcase as your
reference; it stays here and is never copied.

A generated workspace depends on SSSB's packages by version and upgrades by release: move the packages to the new
version and follow its release notes ([docs/adopting.md](docs/adopting.md), "Upgrading by release";
[ADR-0014](docs/adr/0014-distribution-as-versioned-packages.md)). You never fork or merge this repository.

## What this is not, and what to expect

**It is a framework you start from, not a library you add.** Its code ships as versioned packages (`@sssb/kit` and
its siblings), but you don't `pnpm add` it to an existing app: `pnpm create @sssb` writes a workspace that carries the
verify gate, the lint fences, the CI workflow and the agent guide along with your app, and upgrades arrive as
releases of the packages. [ADR-0014](docs/adr/0014-distribution-as-versioned-packages.md) explains the split between
what the packages carry and what the generator writes once.

**It is opinionated on purpose.** One component library, one data layer, one way to do tenancy. The
decisions are written down in `docs/adr/` with their reasoning, and treated as settled for routine work.
New information reopens one; taste does not.

**Some of it is authored but unverified.** Every adapter that needs a real credential — auth, email,
LLM, object storage, analytics — is typechecked against its vendor SDK and has never spoken to the real
service. Those carry an `AUTHORED — CUTOVER` header and a row in
[docs/cutover-checklist.md](docs/cutover-checklist.md) naming the exact proof each one owes. SSSB is honest
about this rather than quietly hoping; the fakes are what you actually develop against.

**Who maintains it.** SSSB is maintained by SafeInsights, and it is not SafeInsights-specific. The guard is the
universality test in [docs/development-approach.md](docs/development-approach.md) ("What SSSB ships"):
vendor code ships only if essentially every product built on SSSB will use it or it demonstrates a class of
integration SSSB does not yet teach, a component only if it encodes a framework invariant, and
everything else is a recipe.

**Support posture.** Issues and PRs are welcome — especially improvements to
the framework half from someone who has adopted it, since that is the only way a second consumer ever
checks the seam. Expect a straight answer, not a fast one.

## Where things are

- `packages/kit/` — **the framework**: ports, adapters, core, db/RLS, authz, i18n, the Simulator harness
  and the generic screens (ADR-0012)
- `packages/tools/`, `packages/eslint-plugin/`, `packages/cdk/`, `packages/create/` — the `sssb` CLI and the config
  presets, the lint fences, the CDK construct each `apps/<app>/infra/` composes, and the generator (ADR-0014)
- `apps/` — one directory per app, each self-contained (its own `package.json`, configs, e2e and contract
  tests); single-app root commands delegate to `apps/showcase` (ADR-0007)
- `apps/<app>/src/` — **an app**: routes (`apps/<app>/src/app`), the registration seam
  (`apps/<app>/src/app-config`), domain modules, product cards, the static demo twin
- [docs/README.md](docs/README.md) — the map of the doc set: binding doctrine (path-gated), dated records,
  and where the backlog lives
- [docs/development-approach.md](docs/development-approach.md) — the engineering philosophy, and why
- `docs/adr/` — the architecture decisions: 0001–0012 and 0014 Accepted, 0013 Superseded by 0014, 0015 Accepted in part (the design is decided, not aspirational)
- `docs/cutover-checklist.md` — every deferred item that needs real credentials, and the proof each owes
- [CONTRIBUTING.md](CONTRIBUTING.md) — conventions, how to add an adapter, commit format

## License

MIT — see [LICENSE](LICENSE). Take it, build a product on it, keep the product yours. If you improve the
framework half, a PR back is appreciated but not owed.
