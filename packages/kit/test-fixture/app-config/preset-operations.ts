import type { FlagArgs } from '@sssb/kit/core/presets'
import {
    frameworkPresetOperationHandlers,
    type ServerPresetOperationHandler,
} from '@sssb/kit/server-lib/preset-operations'
import { docketFlagServer } from './presets/operations/docket-flag/server'

/**
 * The fixture's SERVER halves of its preset operation kinds (@sssb/kit/server-lib/demo-presets.ts composes
 * them over SSSB's own) — the seam's server-only module, ADR-0012. Two entries, one per thing SSSB's
 * replay test must prove:
 *
 * - `docket.flag`, an APP kind: the fixture's own vocabulary, consuming a named result.
 * - `flag`, SSSB's kind NAME: an app entry with a framework kind's name replaces SSSB's half. This one
 *   wraps SSSB's (the way an app customising a kind would start) and records each call, so the test can
 *   tell that the app's entry, not SSSB's, is the one the dispatcher ran.
 */

/** Every flag the replacing `flag` half set, in order. Read by @sssb/kit/server-lib/demo-presets.test.ts. */
export const replacedFlagCalls: FlagArgs[] = []

const flag: ServerPresetOperationHandler<FlagArgs> = async (args, ctx) => {
    replacedFlagCalls.push({ flag: args.flag, enabled: args.enabled })
    await frameworkPresetOperationHandlers.flag(args, ctx)
}

export const appPresetOperationHandlers: Record<string, ServerPresetOperationHandler> = {
    'docket.flag': docketFlagServer,
    flag,
}
