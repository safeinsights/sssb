---
'@sssb/kit': minor
---

### Job handlers get the auth port, and the digest addresses real members

**Kind.** seam

**Action.** required

**What changed.** A job handler's context (`JobHandler`'s second argument, `@sssb/kit/ports/jobs`) now carries `auth`,
the auth port, for handlers that address people, and an optional `resolveLocale`, a person's own locale where the runner knows it (in a simulated world). The framework's `digest-email` handler uses it: it sends a team's
digest to the team's first active admin (else its first active member) as `auth.listMembers` lists them, which in a
deployment is the identity provider, instead of a person from the seed. In a deployment, a team with no active
member gets no digest; the simulated world is unchanged. No job handler reads the seed any more, and none may.

**To adopt.** Where your own code calls a job handler directly (a unit test, say), pass `auth` in its context beside
`llm`: an auth port, or a stand-in typed as one. A handler of yours that addresses people asks
`ctx.auth.listMembers(orgSlug)`, never `@sssb/app-config/seed`, which a deployment does not have.

**Now deletable.** A recipient list or address map a handler kept so that it would not read seed people in a
deployment.
