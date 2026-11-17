/**
 * Fail-fast preflight for `pnpm dev:real`: prints exactly which cutover items are missing
 * instead of letting the server crash on first request.
 */
import { assertRealEnv } from '@sssb/kit/adapters/real/index'
import { CutoverPendingError } from '@sssb/kit/ports/errors'

try {
    assertRealEnv()
    console.log('real-mode env complete — starting dev:real')
} catch (error) {
    if (error instanceof CutoverPendingError) {
        console.error('\ndev:real is not available yet.\n')
        console.error(error.message)
        console.error('\nEach item is a row in docs/cutover-checklist.md with what unlocks it.\n')
        process.exit(1)
    }
    throw error
}
