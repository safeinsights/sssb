# The starter has no wiring for capabilities SSSB ships screens for

**Priority:** P2 · **Status:** open — a design question to settle before any code
**Found by:** the demo-presets documentation pass, 2026-10-03.

## What is true (re-measured against the tree)

An adopter's workspace (`pnpm create @sssb`) holds `apps/starter`, renamed. It is the minimum
an adopter keeps and the framework's falsifier, and its route tree shows it: the sign-in picker, the
protected dashboard, `api/auth/{dev-signin,org,signout}` and one entity's route. It has none of the wiring
the showcase uses to reach capabilities SSSB ships screens for:

| Capability          | SSSB ships                                                   | Wiring that exists only in `apps/showcase`                                                                                            |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Inviting someone    | `OrgScreen`, `sendOrgInvite` (`@sssb/kit/server-lib/invite`) | `apps/showcase/src/app/[locale]/(protected)/org/` and `apps/showcase/src/app/api/org/invite/route.ts`                                 |
| Accepting an invite | the accept-invite screen                                     | `apps/showcase/src/app/[locale]/accept-invite/` and `apps/showcase/src/app/api/auth/accept-invite/route.ts`                           |
| The Simulator panel | the panel, every tab, the replay code                        | `apps/showcase/src/app/[locale]/simulator-glue.tsx` (about 800 lines) and 32 route files under `apps/showcase/src/app/api/simulator/` |

So **the Simulator is not reachable from the starter's own `pnpm dev`**: the glue the layout dynamic-imports
in simulated mode exists only in the showcase (`apps/showcase/src/app/[locale]/layout.tsx`). Presets, tours
and every Snapshots feature are therefore reachable in the starter only through its static demo
(`apps/starter/src/demo-static/app.tsx`), where the panel is the package's and needs no server. The
registration seam is there (`apps/starter/src/app-config/presets.ts` and `tours.ts` register nothing today),
and a server host for it is not.

The consequence lands on the adopter the day after generating. A preset or tour written with `/sssb:new-preset` or
`/sssb:new-tour` is watchable only in the static demo; `pnpm dev` has no panel to load it from, and no org screen
or accept route for an `invite` step to lead into.

## The question to decide

Should the starter carry **thin, adopter-owned wiring** for the capabilities SSSB ships screens for — the
invite and accept routes, the Simulator glue and its routes — with SSSB's helpers (`sendOrgInvite`, the
screens) as optional functions that wiring calls?

For: it follows the principle the repo already states for the seam — provide a starting point, keep it in
the adopter's hands — and it closes the gap above. It would also make the starter a real second consumer of
the invite and Simulator code, where today only the showcase exercises them.

Against, and these are the reasons this is a question rather than a task:

- **It raises the minimum.** The starter is "the minimum an adopter keeps", and its empty registrations are
  the off switch for a capability. Route files are not registrations: nothing turns a wired invite route
  off by registering nothing, so an adopter who does not want invitations must delete files.
- **ADR-0013.** Upstream improvements reach a fork by `git merge`, and `apps/<yours>/**` merges clean
  precisely because upstream never touches it. The corollary is that a fix to starter wiring never reaches an
  adopter who renamed it: the improvement lands as a delete/modify conflict they resolve as "keep deleted".
  Logic that must keep improving belongs behind SSSB's functions and screens, which DO flow through the merge,
  and the wiring has to stay too thin to need fixing.
- **It adds glue duplication.** Every file here would be another showcase-and-starter clone pair
  (`route-glue-duplication.md`), and that file's trigger — promote glue into SSSB as re-exportable handlers —
  pulls the opposite way from "adopter-owned": a one-line re-export is merge-friendly and not the adopter's
  code. These two tasks are one decision.
- **Bytes.** Anything the starter's static demo gains is paid against the starter's budget, which an adopter
  inherits and owns and which is sized for their growth (`resolved/demo-size-budget-headroom-thin.md`).

## Options, roughly

1. **Wire it into the starter.** Simplest for the adopter, largest minimum, most duplication.
2. **Keep the starter minimal and ship a scaffold command** (an `/add-simulator`, `/add-invitations`, in the
   style of `plugins/sssb/commands/new-tour.md`) that writes the wiring into the adopter's app on request. The
   minimum stays small and the wiring is still theirs, but an agent command is not a gate, and CI cannot
   prove the wiring still compiles unless an adoption-probe leg runs it.
3. **Promote the wiring into SSSB as re-exportable route handlers**, so the adopter's route file is one line.
   Closest to `route-glue-duplication.md`, merge-friendly, and the least "in the adopter's hands".

Whichever is chosen, the adoption probe in `.github/workflows/checks.yml` (a workspace generated with the packed
`@sssb/create`, then its `pnpm verify`) is what makes it a gate: generate, add the capability, `pnpm verify`.

## Related open tasks

- `route-glue-duplication.md` — the same decision from the other side; read first.
- `self-service-auth-mfa-and-invitations.md` — widens the accept-invite flow into three; whatever the
  starter wires now is what that work has to keep working, so settle ownership of the accept route first.
- `create-blank-option.md` — decides what "the minimum an adopter keeps" is, and a starter that carries
  more wiring has more for `--blank` to sweep.
- `resolved/demo-size-budget-headroom-thin.md` — the byte cost of anything added to the static demo, and whose budget it is.

## Addendum, 2026-11-18: the adoption review

Fork and merge is gone (ADR-0014), so the ADR-0013 argument above no longer applies as written, and its replacement
points the same way: the starter is copied once, so wiring in it never improves after generation, while what ships in
`@sssb/kit` arrives with each release. That favours option 3-shaped work over option 1: the Simulator's server glue
and its routes as handler factories in the kit, and route files in the starter thin enough never to need a fix. The
adoption review (`docs/adoption-review-2026-11.md`, follow-up 6) ranks it high in value and high in cost: the Simulator
is the README's first claim, and a generated app's own `pnpm dev` does not have it.

Staging, from the review's Fable reviewer: one catch-all route an app mounts with a single file
(`api/simulator/[...path]/route.ts` over a handler the kit exports) rather than 33 thin ones, and the tabs a new app
uses first (people, jobs and the clock, the mail inbox) before the rest.
