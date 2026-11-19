---
'@sssb/kit': minor
---

### The Simulator's People, Mail and Jobs tabs on an app's own `pnpm dev`

**Kind.** seam

**Action.** optional

**What changed.** Two new published subpaths serve the Simulator panel from an app's own server. `@sssb/kit/server-lib/simulator-api` exports `simulatorApi(request, context)`, one handler for every `/api/simulator/*` call, simulated mode only (404 in a real build), with People (`summary`, `viewpoint`), Mail (`mail`, `mail/clear`, `mail/seen`) and Jobs with the world clock (`jobs`, `jobs/run-pending`, `schedules`, `clock`, `schedules/run-due`); any other path is a 404, every POST must send `content-type: application/json` (415 otherwise), and a known path with the wrong method is 405. `@sssb/kit/components/simulator/simulator-host` exports `SimulatorHost`, the panel client that calls it. `SimulatorPanel` now shows a tab only when its host passes that tab's props (People always), so a host that wires every tab sees no change.

**To adopt.** Mount the handler with one route file, `src/app/api/simulator/[...path]/route.ts`, whose `GET` and `POST` each open with the simulated-mode 404 and import the handler only after it, so the authorization scan's `simulator/` exemption holds:

```ts
import { isSimulated } from '@sssb/kit/adapters/index'
import type { SimulatorRouteContext } from '@sssb/kit/server-lib/simulator-api'

export async function GET(request: Request, context: SimulatorRouteContext): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const { simulatorApi } = await import('@sssb/kit/server-lib/simulator-api')
    return simulatorApi(request, context)
}
// POST: the same body.
```

Then render the panel around the page from `src/app/[locale]/layout.tsx`, in simulated mode only and through a dynamic import, as SSSB's starter does: `const { SimulatorHost } = await import('@sssb/kit/components/simulator/simulator-host')`, then `<SimulatorHost locale={locale}>{children}</SimulatorHost>`. An app with Simulator glue of its own (route files under `src/app/api/simulator/` and a client glue) can keep it: a route file of its own still wins for its path. Snapshots, presets, tours, the other subsystem tabs, the dev ticker and app-registered tabs are not served yet; keep your glue while you use them.

**Now deletable.** Hand-written `src/app/api/simulator/{summary,viewpoint,mail,mail/clear,mail/seen,jobs,jobs/run-pending,schedules,clock,schedules/run-due}/route.ts` wrappers over the fake adapters, once a client glue no longer calls anything else under `/api/simulator/`.
