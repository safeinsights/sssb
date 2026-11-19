---
'@sssb/create': patch
'@sssb/kit': patch
'@sssb/tools': patch
---

### A generated app's port slot is its own, so it never says `starter`

**Kind.** scaffold

**Action.** optional

**What changed.** `pnpm create @sssb` now gives the app a port slot named for its slug, at port 3700:
`"sssb": { "port": { "name": "<slug>", "default": 3700 } }`, or `sssb-app` for a slug a slot cannot be named for. Its
override is `<SLUG>_PORT`. The app's `dev` and `tick` scripts (`sssb dev-tick`, `sssb tick`) and its
`playwright.config.ts` (`originForApp(__dirname)`) name no slot and read the declaration. Before, the app declared
SSSB's built-in `starter` slot (port 3100, `STARTER_PORT`) and named it in all three. The app guide's example now shows
a slot of the app's own. The generated README, `CLAUDE.md` and CI workflow name `pnpm exec sssb pin` where they say to
raise SSSB's pins.

**To adopt.** Nothing is required: `"sssb": { "port": "starter" }` keeps working, on the same port. To give your app a
slot of its own, as a new workspace's has:

```json
"sssb": { "port": { "name": "<your app>", "default": 3700 } }
```

in the app's `package.json` (any port from 1024 to 49151 outside SSSB's own: 3000, 3100, 3200-3599, 5439-5639,
20000-29999, 61000-61199). Then, in its scripts, `sssb dev-tick starter -- …` becomes `sssb dev-tick -- …` and
`sssb tick starter` becomes `sssb tick`; in `playwright.config.ts`, `originFor('starter')` becomes
`originForApp(__dirname)`, imported from `@sssb/tools/ports`. The app's local port then moves to the default you chose,
and its override from `STARTER_PORT` to `<YOUR_APP>_PORT`. A second app in the workspace must not take the same port.
Refresh the app guide's copy as after any upgrade (`pnpm exec sssb guide`).

**Now deletable.** A `starter` in an app's scripts and Playwright config, once the app declares a slot of its own.
