import path from 'node:path'
import { conformanceSuite } from '@sssb/kit/testing'

// SSSB's conformance suite, run against THIS app's seam and route tree (ADR-0014 part 3). Keep this file in the app's
// own tree: that is what makes the checks run by default. Leaving a check out takes a named opt-out with a reason,
// `optOut: { '<check id>': '<why>' }`; the ids are in @sssb/kit/testing/checks.json.
conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })
