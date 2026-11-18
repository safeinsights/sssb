/**
 * `@sssb/kit/testing`: the conformance suite an app runs from its own tree (`src/sssb.conformance.test.ts`), so the
 * framework's checks hold against the app's own seam (ADR-0014 part 3). The checks it registers are data:
 * `@sssb/kit/testing/checks.json`.
 */
export { conformanceSuite } from './conformance/suite'
