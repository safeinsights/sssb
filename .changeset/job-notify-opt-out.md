---
'@sssb/kit': minor
'@sssb/create': minor
---

### A job kind can opt out of completion notifications

**Kind.** seam

**Action.** optional

**What changed.** Every app job kind notified its team's admins when a job ended, on every runner (the simulated one, the in-process one and its sweep, and the CodeBuild webhook), which for a kind a schedule runs every hour is a notification, a `listMembers` call and an email attempt a day for nothing. The seam's `jobs` module may now export `jobNotify`, saying per kind when its end is notified: `'always'` (today's behaviour, and the default), `'failure'` (only a failed job, a lost one the sweep fails included) or `'never'`. A run a kind refuses makes no `listMembers` call, no in-app notification and no email attempt, on every runner. The static demo's `useDemoWorld` takes the same map as its `jobNotify` option. `JobNotify` is a type of `@sssb/kit/core/jobs`. The app guide and `/sssb:new-job` say so.

**To adopt.** Nothing, unless you want it: an app with no `jobNotify` export behaves as before. To silence a routine kind, export the map from `src/app-config/jobs.ts`:

```ts
import type { JobNotify } from '@sssb/kit/core/jobs'

export const jobNotify: Partial<Record<AppJobKind, JobNotify>> = {
    'sweep-items': 'failure',
}
```

If the static demo starts that kind, pass the same map to `useDemoWorld({ jobNotify })`, from a module both import (the seam's `jobs` module imports every server handler, which the demo's bundle cannot carry).

**Now deletable.** A local patch or filter that keeps a routine job's end from notifying (an edited kind allowlist, a wrapper around `notifyJobTerminal`).
