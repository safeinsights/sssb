import type { DemoPreset } from '@sssb/kit/core/presets'
import { fresh } from './fresh'
import { midDemo } from './mid-demo'
import { multiTenant } from './multi-tenant'

/**
 * The registered presets, in the order the Snapshots tab shows them; `../presets.ts` re-exports this as the
 * seam's `presets`. A list of its own, apart from the operation definitions there, because the static demo's
 * Playwright spec iterates it (tests/demo-static/static-shell.spec.ts) and a spec may reach the kit only through
 * `@sssb/kit/testing/e2e` (ADR-0014 part 2): the preset files import nothing from the kit but types, while the
 * `ticket.assign` definition runs the kit's ability rules.
 */
export const presets: DemoPreset[] = [fresh, midDemo, multiTenant]
