# A single-file showcase demo on each release, linked from the README

**Was:** P3 · **Status:** RESOLVED 2026-11-18 (`feat/hosted-showcase-demo`)
**Found by:** the adoption review, 2026-11-18 (`docs/adoption-review-2026-11.md`, follow-up 4).

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

## What was built

- **release.yml's `demo` and `github-release` jobs** run on a plain release's tag, after `pack` (so only for a plain tag
  on `main` once `checks` passed on it), beside `publish`: neither needs it, it needs neither, and neither holds an
  id-token, an environment or a secret. `demo` (`contents: read`, `actions: read`) downloads the `static-demo-showcase`
  artifact the checks run on the release commit built, size-checked and drove from `file://`, checks it with
  `release.mjs demo` (named `sssb-showcase.html`, an HTML document, within the showcase's `check:demo-size` budget) and
  writes the page's notes with `release.mjs release-notes`. `github-release` (`contents: write` only, nothing checked
  out or installed) creates a draft, attaches the demo, checks it byte for byte, and publishes it, marked Latest while
  its tag is the highest plain release tag; a re-run finishes a draft or confirms a published release.
- **The asset name carries no version** (`sssb-showcase.html`, not the design's `sssb-showcase-<version>.html`), so
  the README's `releases/latest/download/sssb-showcase.html` always names the latest release's copy.
- **"Fails before it publishes"** is the CI gate's: a demo that does not build or exceeds its budget fails `checks`'
  demo-static job, and `pack` waits for `checks` to pass on the release commit. The new jobs add no failure mode to
  the npm path.
- Tests: `tests/tooling/release-reach.test.ts` (the job list, nothing upstream of `publish` but `pack`, nothing
  downstream of it, the new jobs' permissions and artifact), `tests/tooling/release-github-release-job.test.ts` (the
  write step against a fake `gh`), `tests/tooling/release-demo.test.ts`. Decisions: `docs/decision-log.md`,
  2026-11-18, "A hosted showcase demo on each release".
- Not yet exercised on GitHub: the first plain release after 0.2.0 is the first run. 0.2.0 has no GitHub release, so
  the README's link answers 404 until then.
