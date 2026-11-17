import type { ServerPresetOperationHandler } from '@sssb/kit/server-lib/preset-operations'

/**
 * The SERVER halves of the app's demo-preset operation kinds (@sssb/kit/server-lib/demo-presets.ts composes
 * them over SSSB's own) — a server-only seam module (ADR-0012), separate from `./presets.ts` because the
 * static demo bundles that one and must never bundle a server half. EMPTY REGISTRATION: this app adds no
 * kinds, so SSSB's `invite`, `inbound`, `flag` and `actor.hold` are the whole registry.
 */
export const appPresetOperationHandlers: Record<string, ServerPresetOperationHandler> = {}
