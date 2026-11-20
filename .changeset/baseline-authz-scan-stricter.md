---
'@sssb/kit': minor
---

### The authorization scan refuses denials that cannot stop the handler, and reads Server Actions

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check passed handlers whose `authorize(...)` denial could
never stop the mutation, and never read some code Next serves. It now fails:

- `authorize` in an async callback to an iteration method on any receiver (`await parse(req).ids.map(async ...)`,
  `items.forEach(async ...)`), in an async mapper to `Array.from`, and under `Promise.allSettled`, `any` or `race`;
- `authorize` in a callback that never carries its failure, awaited or not: `setTimeout` and the other timers (also
  as `globalThis.` members or from `node:timers`), `queueMicrotask`, `process.nextTick`, `Promise.resolve`, `after()`
  from `next/server`, a `.catch`, `.finally` or listener callback, the second argument of `.then`;
- `authorize` in a function handed to a wrapper that runs it in place, returned from inside a `try` whose `catch`
  does not rethrow (`try { return tracer.startActiveSpan('x', () => { authorize(...) }) } catch {}`);
- an exemption whose gate call never runs (handed to a same-file function, in a lazy iterator, in a detached
  callback);
- a Server Action that does not reach `authorize`: every export of a `'use server'` file and every function whose
  body opens with `'use server'`, anywhere under `src`, read-only ones included. No exemption applies to an action;
- what Next serves and the scan cannot read: a `pages/api` or `src/pages/api` directory, a root-level `app/`
  directory, a file under `src/app` named `route.<ext>` other than `ts`, `tsx`, `js`, `jsx` or `mjs` (tests, stories,
  snapshots and declarations excepted), a `'use server'` file in the app outside `src`;
- a simulated-mode opening (`if (!isSimulated) ...`) that throws anything but a global `Error` or an error imported
  from `@sssb/kit/ports/errors`, or that sits in a file assigning to `Response`, `NextResponse`, `JSON` or an `Error`
  global.

It now accepts `await Promise.all(items.map(...))` (or returned) where the callback is async or returns the promise,
`Promise.all(Object.entries(m).map(async ...))`, a `'use strict'` prologue before the simulated-mode opening, and a
route directory reached through a symbolic link, which it reads at the path Next serves.

**To adopt.** Run the conformance suite. For a handler it now fails, call `authorize(...)` first, unconditionally,
before any `try`, and `await` whatever carries it:

```ts
export async function POST(request: Request) {
    return withPortErrors(async () => {
        const user = await requireUser()
        authorize(user, 'update', { type: 'Item', orgId: user.orgId })
        const { ids } = await readBody(request)
        await Promise.all(ids.map((id) => db.withTenant(user, (tx) => archive(tx, id))))
        return Response.json({ ok: true })
    })
}
```

Give each Server Action the same call, and move a route served from `pages/api` or a root-level `app/` under
`src/app`. Two correct shapes are still refused, with a message that says so: `Promise.all(...).then(f)` (await it
instead) and an un-awaited sync `forEach` on a value taken straight from an imported call (bind the array to a local
first).
