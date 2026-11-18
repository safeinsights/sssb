import { contractSuite } from '@sssb/kit/testing/contract'
import { portFor } from '@sssb/tools/ports'

/**
 * The "fakes can't drift" job for this app: the SAME migrations + RLS proof suite that runs on pglite in unit
 * tests, executed against REAL Postgres, in a database of this app's own (`<slug>_contract`), by a non-superuser
 * owner, by a superuser, and over the RDS Data API transport through its emulator. Everything is the contract
 * runner's (`@sssb/kit/testing/contract`), which reads the app through its seam; this file only says where the
 * embedded Postgres listens and which checks, if any, the app leaves out (`optOut: { '<check id>': '<why>' }`).
 *
 * Run via `pnpm test:contract` — deliberately not part of the fast unit suite. Locally that's embedded-postgres
 * binaries (no docker on the dev VM); in CI, CONTRACT_DATABASE_URL names a postgres service container.
 */
contractSuite({ port: portFor('contractPg'), optOut: {} })
