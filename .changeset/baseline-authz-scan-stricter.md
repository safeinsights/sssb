---
'@sssb/kit': minor
---

### The authorization scan refuses denials that cannot stop the handler, and reads Server Actions

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check passed handlers whose `authorize(...)` denial could
never stop the mutation, and never read some code Next serves. It now fails:

- `authorize` in an async callback to an iteration method (`await parse(req).ids.map(async ...)`,
  `items.forEach(async ...)`), in an async mapper to `Array.from`, and under `Promise.allSettled`, `any` or `race`;
- `authorize` in a callback that never carries its failure, awaited or not: `setTimeout` and the other timers (also
  as `globalThis.` members or from `node:timers`), `queueMicrotask`, `process.nextTick`, `Promise.resolve`, `after()`
  from `next/server`, a `.catch`, `.finally` or listener callback, the second argument of `.then`;
- `authorize` in a function handed to a wrapper that runs it in place, returned from inside a `try` whose `catch`
  does not rethrow (`try { return tracer.startActiveSpan('x', () => { authorize(...) }) } catch {}`);
- an exemption whose gate call never runs (handed to a same-file function, in a lazy iterator, in a detached
  callback);
- a Server Action that does not reach `authorize`: every export of a `'use server'` file and every function whose
  body opens with `'use server'`, anywhere under `src`, read-only ones included. No exemption applies to an action.
  A `'use server'` file exports only its actions, each declared in that file: a re-export or a non-function export
  fails, and a test or story file that carries the directive is judged too;
- what Next serves and the scan cannot read: a `pages/api` or `src/pages/api` directory, a root-level `app/`
  directory, a file under `src/app` named `route.<ext>` other than `ts`, `tsx`, `js`, `jsx` or `mjs` (tests, stories,
  snapshots and declarations excepted), a `'use server'` file in the app outside `src`;
- a simulated-mode opening (`if (!isSimulated) ...`) that throws anything but a global error (`Error`, `TypeError`,
  any global `...Error`) or an error imported from `@sssb/kit/ports/errors`, or that sits in a file assigning to
  `Response`, `NextResponse`, `JSON` or an `Error` global.

It now accepts `await Promise.all(items.map(...))` (or returned) where the callback is async or returns the promise,
`Promise.all(Object.entries(m).map(async ...))`, a `'use strict'` prologue before the simulated-mode opening, and a
route directory reached through a symbolic link, which it reads at the path Next serves.

**To adopt.** Run the conformance suite. For a handler it now fails, call `authorize(...)` before the mutation and
before any `try`, on a path every request takes: after `auth.requireUser()` and the lookups that give it the org, never
inside a condition or a loop. `await` whatever carries it:

```ts
const user = await auth.requireUser()
// ... resolve tenantId and orgId as the generated app's src/app/api/items/route.ts does ...
authorize(user, orgId, 'update', { type: 'Item', orgId })
await Promise.all(ids.map((id) => db.withTenant(tenantId, (trx) => archive(trx, id))))
```

Give each Server Action the same call, and move a route served from `pages/api` or a root-level `app/` under
`src/app`. Two correct shapes are still refused, with the ordinary "does not reach authorize(...)" message, which
does not name them: `Promise.all(...).then(f)` (await the `Promise.all` and put the rest after it) and an un-awaited
sync `forEach` on a value taken straight from an imported call (bind the array to a local first).
