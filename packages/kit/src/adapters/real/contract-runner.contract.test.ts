import { contractSuite } from '../../testing/contract'

// The SHIPPED contract runner (what every app's tests/contract file calls), over the kit's own fixture seam. The kit's
// other contract tests build their connections themselves; this one proves the runner adopters call connects through
// the real adapter: the fixture's proofs include the `date` parity proof (dockets.due_on), which a bare `pg` Pool
// failed (a JS Date where the deployed adapter returns the string).
contractSuite({ database: 'kit_runner_contract' })
