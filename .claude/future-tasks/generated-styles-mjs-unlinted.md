# A hand-written `.js` in the generated styles directory escapes every lint fence

**Priority:** P3 · **Status:** open
**Found by:** review round 2 of `fix/lint-fence-gaps` (2026-11-16), and again in round 1 of
`fix/lint-import-fences-getdb-default`. It is documented in `docs/recipes/app-owned-adapter.md`'s Limits.

The file name says `.mjs` because Panda 1 wrote `.mjs` there; Panda 2's default `outExtension` is `js`, and the
upgrade to it (2026-11-17) moved the hole from `.mjs` to `.js`. The name is kept because the decision log cites it.

## What is true

The app preset (`packages/eslint-plugin/src/app-config.js`) ignores `src/styles/generated/**/*.{js,d.ts}` in every
app globally: that is what Panda's
codegen writes there, and its output does not lint. The directory is committed, and `panda codegen` runs
without `--clean`, so a hand-written `.js` file in it survives regeneration and is never linted. A route can
import it, so it can import a vendor SDK, read `process.env` or take the raw db handle with a green `pnpm lint`.
It is the one tracked place under `apps/*/src` where that holds. A hand-written file with any other extension
ESLint lints (`.ts`, `.mjs`, `.jsx`, …) IS linted, and `tests/lint/extensions.test.ts` pins each one.
jpslav/keel#38 narrowed the ignore from the whole directory to the two extensions Panda writes.

Nothing in the tree does this today.

## What done looks like

One of these, decided with whoever owns the styling setup:

- Lint Panda's output instead of ignoring it, with only the fence rules on (`sssb/no-raw-db-handle`, the
  vendor bans, the process.env ban) and the style rules off. The output must pass them already; check that
  first.
- Or narrow the ignore to the exact paths Panda writes (`helpers.js`, and `css/`, `jsx/`, `recipes/`,
  `tokens/`, `types/`). A hand-written `.js` beside them in one of those subdirectories would still pass, so
  this only shrinks the gap.
- Or move the generated directory out of `apps/showcase/src`. Nothing imports the generated modules today
  (the CSS comes through `@pandacss/dev/postcss`), so this costs less than it once looked; any later
  styled-system import would follow the move.

A fourth option arrived with Panda 2, and it does not help on its own: `outExtension: 'ts'` in `panda.config.ts`
makes the output TypeScript (only `.ts` files, no `.d.ts`), so the ignore would have to name `.ts` instead and a
hand-written `.ts` would become the unlinted file, unless the output is linted as in the first option.

Whichever it is, add a case to `tests/lint/extensions.test.ts` that a hand-written `.js` in that directory
is fenced, and see it fail first.
