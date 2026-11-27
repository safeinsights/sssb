---
'@sssb/kit': patch
---

### The Simulator's Snapshots tab, demo presets and tours on an app's own `pnpm dev`

**Kind.** none

**Action.** none

**What changed.** `simulatorApi` (`@sssb/kit/server-lib/simulator-api`) now also serves the world's knobs: `reset`,
`snapshots` (GET a list, POST `{ name }` to save), `snapshots/restore` and `snapshots/delete` (`{ name }`), `flags`
(GET every known flag, POST `{ flag, enabled }`), `agreements` and `agreements/bump` (`{ agreementId }`), and `presets`
(`{ name, locale }`, answering `{ redirectTo }`). Each keeps the host's rules: simulated mode only (404 in a real
build), JSON-only POSTs (415 otherwise), no role gate. `SimulatorHost` wires them into a Snapshots tab (reset, save,
restore and delete snapshots, flip a feature flag, bump an agreement, load a demo preset) and, when the app registers
any tours, a Tours tab, whose tours start their world through the same reset, preset and restore calls. A reset, a
restore or a preset load reloads the page and says what it did in the panel; a flag reloads it too. An app that mounts
the catch-all route and `SimulatorHost` gets all of it with nothing to change.
