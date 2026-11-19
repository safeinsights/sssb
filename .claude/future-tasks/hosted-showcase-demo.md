# A single-file showcase demo on each release, linked from the README

**Priority:** P3 · **Status:** open
**Found by:** the adoption review, 2026-11-18 (`docs/adoption-review-2026-11.md`, follow-up 6).

## What is true

The showcase's static demo (`pnpm build:demo-static` in `apps/showcase`) is one HTML file that runs from `file://`,
Simulator and tours included. Today an evaluator sees it only by cloning SSSB, installing and building, and
`docs/adopting.md` ("First boot") sends a new adopter to a checkout of SSSB for the demo tour.

## Design

The release workflow builds the showcase's static demo and attaches `sssb-showcase-<version>.html` to the GitHub
release, and the README links the latest release's asset. It is SSSB's own artifact, never something a workspace
installs, so it takes no changeset. It touches `.github/workflows/release.yml` and the release scripts, so it waits
for whoever next owns them.

## Done when

The README's first screen links a demo that opens in a browser with no install, and a release whose demo does not
build fails before it publishes.
