---
'@sssb/kit': minor
---

### The authorization scan no longer counts an `authorize` whose promise the handler never awaits

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check counted `authorize(...)` inside an `async` helper
the handler called without awaiting it. The helper's `ForbiddenError` then became an unhandled rejection, and the
handler went on to mutate. Now a call into an `async` function, or a call a function is handed to (a wrapper,
`.then`, a timer, `forEach`), counts only when the handler `await`s or returns its result. A synchronous helper, and
`authorize` itself, need no `await`: they throw in place.

**To adopt.** Run the conformance suite (`pnpm test:unit`). A route that now fails `authz-mutations` reaches
`authorize` only through a promise it drops. Await it, or return it:

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

A callback that authorizes needs the call it is handed to awaited or returned too: `return withPortErrors(async () =>
…)`, not `withPortErrors(…)` on a line of its own. For `items.forEach((item) => authorize(…))`, write
`for (const item of items) authorize(…)`. `await check().then(…)` and `const p = check(); await p` fail as well;
write `await check()`.
