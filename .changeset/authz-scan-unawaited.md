---
'@sssb/kit': minor
---

### The authorization scan counts `authorize` only where its denial stops the handler

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check counted `authorize(...)` wherever the handler's path
reached it, even where its `ForbiddenError` could not stop the handler. Now it does not count `authorize` in these
places:

- In an `async` helper, or a callback, whose promise the handler neither awaits nor returns. The denial became an
  unhandled rejection, and the handler went on to mutate.
- In an `async` callback to `forEach`, `map` or another array iteration method, even an awaited one.
- In a callback handed to a function or wrapper defined in the route's own file. The scan does not follow a function
  through a parameter.
- In a `try` whose `catch` does anything but rethrow, or whose `finally` can `return`, `break` or `continue`.

A synchronous helper, a synchronous `forEach` callback, and `authorize` itself still count without `await`: they throw
in place.

**To adopt.** Run the conformance suite (`pnpm test:unit`). A route that now fails `authz-mutations` reaches
`authorize` only where its denial is lost. Await the helper that authorizes, or return it:

```ts
async function check(user: AuthUser, orgId: string) {
    authorize(user, orgId, 'update', { type: 'Item', orgId })
}

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        // ...
        await check(user, orgId) // was: check(user, orgId)
        // ...
    })
}
```

- A callback that authorizes needs the call it is handed to awaited or returned:
  `return withPortErrors(async () => …)`, not `withPortErrors(…)` on a line of its own.
- Write `for (const id of ids) await check(id)`, not `ids.forEach(async (id) => …)` or
  `await Promise.all(ids.map(async (id) => …))`.
- Write `await check()`, not `await check().then(…)` or `const p = check(); await p`.
- Let `withPortErrors` turn the denial into a 403 rather than a `catch` in the handler, or rethrow from the `catch`.
- Move a wrapper the route defines for itself into a module of its own, or call `authorize` in the handler.
