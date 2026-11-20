# ADR-0003 — Auth: Clerk headless behind a port, one custom UI

- Status: Accepted
- Approver: JP Slavinsky
- Date: 2026-08-01

## Context

Dev builds must behave like production (`docs/development-approach.md`), and auth is where that
principle is usually abandoned first: a dev-only stub screen beside a vendor's prebuilt components means
the sign-in path you develop against is not the sign-in path users get, and the difference surfaces at
the worst possible moment. So the question is not "which auth vendor" but "how little of the vendor's
surface can the app depend on".

Managed auth is worth buying — session handling, password reset, MFA, organization membership and invite
flows are a large amount of security-sensitive code nobody should write again. Clerk supplies all of it
and, importantly, exposes it through headless hooks as well as prebuilt components, which makes it
possible to buy the mechanism without buying the UI.

## Decision

**Clerk sits behind a deliberately narrow `auth` port (`packages/keel/src/ports/auth.ts`), and there is
exactly one auth UI — custom Mantine components used in every mode.**

The real adapter wraps Clerk's headless APIs. The fake adapter implements the same port locally: a
people picker that issues a signed session cookie, so the simulated world signs in through the same
interface the real one does. The fake is a first-class adapter, not a stub.

**The port is sized to the app, never to Clerk's API.** It is `getCurrentUser` / `requireUser` /
`requireRole`, `signInPath` / `signOut`, `updateProfile`, `listMembers(orgSlug)` / `createInvite`, and
`listMyOrgs` / `setActiveOrg`. Growing it to mirror a vendor method the app does not call is the failure
mode this shape exists to prevent.

**We own the component surface Clerk would otherwise provide.** `SignInScreen`, `UserMenu`,
`OrgSwitcher`, `ProfileScreen`, `OrgScreen` (member list plus pending invites) and `AcceptInviteScreen`
ship in `packages/keel/src/components/auth/` and the framework screens beside them. Deeper features —
MFA enrollment, sessions/devices, connected accounts, avatar upload — are documented seams rather than
stubs; `docs/auth-ui-playbook.md` maps every Clerk component to its house surface and names the Clerk API
a seam would call.

`<ClerkProvider>` stays adapter-confined (`packages/keel/src/adapters/real/providers.tsx`), real-mode
only, and renders no UI. It is present as the clerk-js runtime for slotted vendor forms and future client
calls, nothing more.

Clerk instances are cutover items: a development instance serves `pnpm dev:real` and real previews, a
production instance is production-only (`auth-dev` and `auth-prod` in `docs/cutover-checklist.md`).

### Tenant ≠ organization

Two concepts that "tenant" alone conflates, and the split is load-bearing everywhere else in the repo:

- **Tenant** = one customer's entire hosted site, separately branded and URL'd. It is **ambient**: it
  comes from the deployment and the session, and users — even tenant admins — never see or switch to
  another tenant. `AuthUser.tenantSlug` is that ambient claim, and it drives per-tenant theming
  (ADR-0005). It is never user-switchable in the product. Cross-tenant control would be a backplane, not
  product UI.
- **Organization** (`org` in code; **"team"** in user-facing copy) = a group of users **within** one
  tenant, GitHub-style: one login, membership in several orgs, and switching orgs switches whose data you
  see. This maps 1:1 onto Clerk Organizations — one Clerk instance per tenant, so an org slug _is_ the
  Clerk org slug and there is no mapping layer. Role is per-org membership; `AuthUser.role` is the role
  in the active org.

The tenant is the **hostile-isolation** boundary and is enforced by row-level security (ADR-0004); the
org is a **collaboration** boundary among mutually-trusting users of one customer, and is an app-level
filter. Those are different promises and they get different mechanisms.

**Naming rule:** identifiers and data use `org`/`organization` — Clerk's word, so no translation layer
exists to get wrong. User-facing copy says "team", in message values only.

In the simulated world, crossing tenants is a Simulator capability (become a person whose home tenant
differs), never a product surface.

### Reusing Clerk's own UI was evaluated and rejected

Adopting Clerk's MIT-licensed `@clerk/ui` components, or `@clerk/elements`, directly was considered.
Rejected on two grounds. `@clerk/ui` is an _internal_ package whose every component binds to a live
clerk-js client through `@clerk/shared/react` hooks and internal contexts — faking that reintroduces the
entire Clerk API surface the port exists to hide — and its visual layer (emotion `styledSystem`,
`customizables`, its own localization) is not cleanly extractable. `@clerk/elements`, the headless
option, is beta and unsupported as of Clerk Core 3. So we **mine Clerk's component anatomy as a design
reference** and re-express it in Mantine, which is what `docs/auth-ui-playbook.md` is.

### Machine callers are a sibling seam, not this port

This ADR and the `auth` port scope to **human, session-cookie callers only**. Services that call the app
— rather than people who sign into it — are verified by `packages/keel/src/service-auth/`: per-org RS256
tokens checked against app-owned `service_keys` rows, plus a shared-secret webhook verifier. That lives
_beside_ the port, not inside it, because it verifies app-owned signatures over app-owned state rather
than wrapping a vendor, and because `ServiceIdentity` is a genuinely different type from `AuthUser`.
Folding it in would have made the port mean "anything that authenticates", which is not a seam.

## Consequences

- Identical auth UX in dev, demo, E2E and production, because there is only one implementation of it.
- Auth features arrive at the speed we build them. That is the accepted cost of owning the UI, and the
  playbook exists to make each one a recipe rather than a research project.
- The port stays small only if it is defended. Every addition should name the app call site that needs
  it.
- **Deferred auth features have a landing pad, not just a note.** The access-gate class
  (`packages/keel/src/core/gates.ts`) is a condition an actor must satisfy before proceeding, evaluated
  once in the protected layout, with a resolution flow and block-or-advisory behavior. MFA enrollment is
  a gate of exactly that shape: a future rider adds an `mfaEnrolled` fact and an `mfa:enroll` gate whose
  `resolutionPath` points at the Clerk enrollment flow, with no change to the evaluator or the layout
  hook. Clickwrap agreements are the worked example that shipped; email verification, onboarding,
  suspension and billing entitlements ride the same seam.

## Addendum (2026-11-16): the port gains `getMember`

The port grows by one method: `getMember(orgSlug, userId)`. It returns `MemberStanding`
(`{ role, restricted }`), or `null` when the user is not an active member of that org. Its call site is
`abilityActorFromCredential` (`packages/keel/src/authz/authorize.ts`). That function builds the person
behind a credential that is not a session: an inbound email from a member's address, or a personal API
token an adopter issues. It calls `getMember` on every request, so the person is judged by their
current role, and a person removed from the org fails on the next call (ADR-0012 addendum of this
date).

`listMembers` could not do this job. `restricted` is a person-level flag: the fake keeps it on the
person, and the real adapter reads it from the user's metadata, while `Membership` has only a role. A
non-session actor built from `listMembers` would therefore have had to guess `restricted`. Inbound email
used to guess it from the role. The real adapter answers `getMember` with the same two facts
`getCurrentUser` reads for the caller: the org membership for the role, then the user's metadata. It
returns null for an org Clerk doesn't have, rather than throwing its 404. It also returns null for a
BANNED user. Banning ends their sessions but leaves their memberships, so without the check their
tokens and email would keep their role. A LOCKED user keeps their standing on purpose: anyone can lock an
account by failing its sign-ins, so treating that as "no standing" would let an attacker kill a victim's
tokens. Each call costs three Clerk requests (the org, the membership, the user) on every non-session
request; the `auth-dev` cutover row measures that against Clerk's rate limits.

**Restriction now has one rule, in both adapters and for both methods.** `isRestricted(flag, role)` in
`keel/core/roles` reads the user's flag OR the `restricted` role in the org in question. Before, the
real `getCurrentUser` read the flag alone. Real-mode invites write only the role, so a `restricted`
invitee was unrestricted in the product while the inbound-email path, reading the role, refused them.
This is a real-mode SESSION change, and a conservative one. The fake world is unchanged, because its
seed sets both. Like the rest of that adapter, it is unverified against a real Clerk instance
(`auth-dev` in `docs/cutover-checklist.md`).

"Machine callers are a sibling seam, not this port" still holds. `ServiceIdentity` and `AuthUser`
remain different types. The two kinds of caller meet in `authorize()`'s actor, not in this port.

## Addendum (2026-11-19): a single-tenant mode, and a configurable tenant metadata key

The Decision places the tenant in the user's metadata and the org and role in the provider's organizations, with one
provider instance per tenant. That costs an app with one tenant per deployment (SSSB's first adopter) a tenant claim on
every account and an organization nobody uses, and it cannot work on a provider instance that the app shares with
another product. JP decided (2026-11-19) to add a mode for it, and to make the metadata key configurable.

**`AUTH_TENANCY`, an explicit switch** (`multi`, the default, or `single`), set by `SssbApp` from the app's
`params.auth` (`packages/kit/src/adapters/auth-tenancy.ts`, `packages/cdk/src/auth-tenancy.js`).

- **multi** is the Decision as it was, with the tenant read under `AUTH_TENANT_METADATA_KEY` (`tenantSlug` by default).
- **single** fixes the tenant and the home org by setting (`AUTH_TENANT_SLUG`, `AUTH_HOME_ORG_SLUG`) and places every
  user the provider signs in there, with the new role `none`. One module, `packages/kit/src/adapters/single-tenant-auth.ts`,
  wraps either adapter, the fake or Clerk, so the mode means the same in a simulated world as in a deployment.

**`none` is a role of its own because no existing role grants nothing.** The framework's rules let every member of an
org read its jobs, members and org record, `restricted` included, and the staff org's manage-all followed the active
org whatever the role. So `none` has no standing (`hasStanding` in `packages/kit/src/core/roles.ts`): the ability layer
puts it in no org for any rule, the framework's or the app's (the app's rules are handed a `sameOrg` that is false for
it, and an active org that matches none, so a rule comparing org ids itself cannot grant it either), and neither
`abilityActorFromUser` nor `defineAbilitiesFor` lets it wield manage-all, which matters because a single-tenant app's
home org may be its staff org.

**The ability layer is only half of it: reads must ask it.** ADR-0004 lets a route scope a read by the session's org,
because in multi mode that org is always a real membership. In single mode it is where a person is placed, not a
membership, so a route that lists an org's data by `user.orgSlug` alone would show it to every user the provider signs
in. The reference apps' org-scoped reads now authorize (`authorize(user, orgId, 'read', …)`), the guide makes it a
rule, and the adopter reference tells an app to check its own before switching the mode on. The authorization scan
still exempts GET handlers, so nothing enforces this for an app's own routes; that gap is named, not closed.

**What the port means in single mode**, each with its reason in the module's header: the current user is the
configured tenant and org with role `none`; `getMember` answers the same for an account the provider still has (so a
credential is judged as a session); `listMembers` is empty, since listing the provider's users would enumerate another
product's users on a shared instance; `createInvite` is refused, since membership is implicit; the home org is the only
org. A user whose metadata claims a different tenant under the key, or holds there something that is not a slug, is
refused and signed out, so the mode switched on for a multi-tenant instance by mistake cannot merge its tenants. The
fake runs the same wrapper wherever the simulated world reaches people (`packages/kit/src/adapters/fake/simulated-auth.ts`:
the registry, the fake job runner, the conformance suite's preset replay).

**What it costs.** On a shared provider instance, every user of the other product is a signed-in person of this app.
SSSB grants them nothing, but whatever the app shows any signed-in person, they see; the adopter reference says so in
as many words. Membership-driven features (an org's admins, invitations, the member list) have nothing to work with in
this mode, by design.
