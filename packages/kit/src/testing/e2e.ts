/**
 * `@sssb/kit/testing/e2e` — everything SSSB offers a Playwright spec, and the ONLY way a spec may reach the kit
 * (ADR-0014 part 2).
 *
 * Playwright loads specs with Node, and Node neither strips types under `node_modules` nor resolves the app's
 * `@sssb/app-config/*` seam the way a bundler does. So in the packed package this subpath resolves to compiled
 * JavaScript (`dist/testing/e2e.js` and its `.d.ts`, built by `scripts/build-testing-e2e.mjs` when the package
 * is packed), and everything it reaches must be SEAM-FREE: that build fails if any file in this
 * entry's closure imports `@sssb/app-config/*`, or if the closure grows past the files it allows. Inside this repo
 * the apps' tsconfig `paths` resolve `@sssb/kit/*` to source, so a spec here runs this file through Playwright's
 * own TypeScript transform; the compiled copy is what an adopter's spec loads.
 *
 * Add a name here only if it is seam-free, and add its file to the build's allowed set deliberately.
 */
export { WEBHOOK_REPLAY_TOLERANCE_MS, verifyWebhookSignature } from '../core/webhook-hmac'
