# Split `docs/adopting.md` into a short guide and a reference

**Priority:** P2 · **Status:** open
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
