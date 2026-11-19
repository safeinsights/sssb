# Split `docs/adopting.md` into a short guide and a reference

**Priority:** P2 · **Status:** resolved 2026-11-19
**Found by:** the adoption review, 2026-11-18 (`docs/adoption-review-2026-11.md`, follow-up 1).

## What is true

`docs/adopting.md` is about 840 lines, and it is the first document every adopter reads. A newcomer needs perhaps
150 of them: generate, first boot, replace the starter's content, build a first slice, cut over, upgrade. The rest is
reference that matters later or never: the generator's refusals in full, what it writes file by file, how
`sssb doctor` asks Vitest what would run, the knip settings and why, the lint-exception file's rules, the dev ticker.
The review added a five-step reading path at the top and moved "Trying an unreleased commit of SSSB" under
"Changing SSSB itself"; the length is unchanged.

## Design

- `docs/adopting.md` keeps the path, each step in a few paragraphs, and links into the reference for detail. Its
  headings that other files link to stay where they are (at least "Upgrading by release", which every generated
  README links with an anchor, held by `tests/tooling/create-generate.test.ts`).
- `docs/adopting-reference.md` takes the reference sections whole, moved rather than rewritten: "`pnpm create @sssb`"
  and its subsections less "What the generator leaves for you", "What the showcase's absence costs", "Layout" and its
  subsections, "The scheduled tick".
- Grep for every citation of a moved heading (`"What it writes"`, `"Identity and the owner files"`, and the rest)
  across the doc set, the plugin, the generator and the release notes' scripts, and repoint each.
- Measure it: the guide's line count before and after, in the PR body.

## Done when

A newcomer reads one document of about 150 lines from generating to upgrading, every section of the old one exists
in one of the two, and the doc-path gate and the create tests are green.

## Resolution (2026-11-19, `docs/adopting-guide-split`)

- **`docs/adopting.md` is the guide**, 921 lines down to 156, in the order a newcomer acts: generate, first boot (with
  the Simulator a generated app's `pnpm dev` now has), take out the starter's content (`sssb remove-items`), a first
  entity file by file with tenant, organization (team) and the staff team defined where the reader first needs them,
  deploy and cut over (`SssbApp`, `params.ports`, the scheduled tick, the checklist), and "Upgrading by release" (kept
  as the heading every generated README links, with `sssb guide` and `sssb pin`).
- **`docs/adopting-reference.md` holds the rest** (836 lines), moved section by section, with the release-candidate
  and fork-era history deleted rather than moved, and the stale "the starter has no server-side Simulator" corrected.
- **The guide's commands were run** against a workspace generated from this commit's packed packages (the generator
  from the checkout, `--sssb` the tarballs): install, Playwright, `pnpm verify` on the fresh workspace (by the newcomer
  review), `pnpm dev` (the app, the Simulator's API), `pnpm tick`, `pnpm build:demo-static`, `pnpm sssb:doctor`,
  `pnpm synth`, `sssb guide`, `sssb pin`, `sssb remove-items --drop-migrations` (dry run and real), `pnpm verify` after
  it, `pnpm knip` and `pnpm lint:fix`, all green. Not run: `pnpm create @sssb` and `npm create @sssb` (they reach npm's
  last release, which predates this branch's commands, so the checkout's generator stood in), and the three `claude
plugin` commands (they change the machine's Claude Code state).
- Citations of moved sections were repointed (`CLAUDE.md`, `CONTRIBUTING.md`, `docs/README.md`, the release-notes
  script, `sssb remove-items`' refusal, kit comments, `public-surface.test.ts`, two open future tasks), and ADR-0014 has
  an addendum naming where its cited sections now live.
