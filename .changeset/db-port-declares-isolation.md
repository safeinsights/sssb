---
'@sssb/kit': minor
---

### The database port declares how it isolates tenants

**Kind.** seam

**Action.** required

**What changed.** `DbPort` (`@sssb/kit/ports/db`) has a required, read-only `isolation`, of the new type
`DbIsolation`. Every database adapter SSSB ships (pglite in simulated mode, node-postgres and the RDS Data API in real
mode) declares `'rls'`: row-level security, proven by the isolation proof suite, as before. Nothing else changes for an
app on Postgres: the same migrations, the same SQL, the same proofs and conformance checks (`rls-pglite` keeps its
name). Inside the kit, what is specific to Postgres is now gathered as the Postgres database family, so a second
database engine can be added beside it later.

**To adopt.** An object you type as `DbPort` yourself, usually a test double, needs the member too, or the typecheck
fails. Add it with the guarantee of the adapter it stands in for:

```ts
const failing: DbPort = {
    isolation: 'rls',
    getDb: () => {
        throw new Error('not used')
    },
    ready: async () => {},
    migrateToLatest: async () => {},
    withTenant: async () => {
        throw new Error('refused')
    },
}
```

A double spread from SSSB's own port (`{ ...db }`) already has it, and one cast with `as unknown as DbPort` compiles
without it, though adding it keeps the double honest.
