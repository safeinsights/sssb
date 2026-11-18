---
'@sssb/tools': patch
'@sssb/kit': patch
---

### An app can declare a port slot of its own, and `sssb doctor` fails two apps on one slot

**Kind.** seam

**Action.** optional

**What changed.** A workspace with two apps made from the starter had both on the `starter` slot, so both dev servers
bound one port, and under Playwright's `reuseExistingServer` the second app's e2e run adopted the first app's server and
tested the wrong app. An app now declares a slot of its own in its `package.json`, beside the string form, which works
as before: `"sssb": { "port": { "name": "ledger", "default": 3700 } }`. The name is lowercase words joined by `-`; the
default is an integer from 1024 to 49151 that no SSSB service's port holds (3000, 3100, 3200-3599, 5439-5639,
20000-29999, 61000-61199). The override is `LEDGER_PORT` (`<NAME>_PORT`, `-` as `_`), and a linked worktree derives the
port from 20000-29999, keyed on the name as well as the checkout. `sssb port`, `sssb tick`, `sssb dev-tick`,
`sssb serve-standalone` and `sssb launch-json` read the declaration; `originFor()` and `portFor()` from
`@sssb/tools/ports`, called with no argument in the app's directory, read it too. `sssb doctor` now fails an invalid
declaration, two apps on one slot, and two slots with one default.

**To adopt.** A workspace with one app needs nothing. A workspace with a second app declares its slot in that app's
`package.json` (above) in place of `"port": "starter"`, and in the app: its `playwright.config.ts` calls `originFor()`
with no argument instead of `originFor('starter')`, its `dev` script is `sssb dev-tick -- next dev …` (no `starter`
before the `--`) and a `tick` script is `sssb tick` (no `starter`), and a contract test's `portFor('contractPg')` stays.
Run `pnpm exec sssb doctor`: it fails while two apps share a slot.

**Now deletable.** A hand-set `STARTER_PORT` or a `--port` literal in the second app's scripts that kept its dev server
off the first app's port.
