import type { ServerPresetOperationHandler } from '@sssb/kit/server-lib/preset-operations'
import { ticketAssignServer } from './presets/operations/ticket-assign/server'

/**
 * The SERVER halves of the app's demo-preset operation kinds, keyed by kind (@sssb/kit/server-lib/demo-presets.ts
 * composes them over SSSB's `invite`/`inbound`/`flag`/`actor.hold`, and an entry with one of those names replaces
 * SSSB's). A server-only seam module (ADR-0012): separate from `./presets.ts`, where the same kinds'
 * DEFINITIONS are, because the static demo bundles that one, and a server half reaches pglite and
 * `server-only` modules that would stop the `file://` bundle from loading. The kinds' static halves are
 * supplied by the static composition root instead (src/demo-static/app.tsx `presetOperations`).
 */
export const appPresetOperationHandlers: Record<string, ServerPresetOperationHandler> = {
    'ticket.assign': ticketAssignServer,
}
