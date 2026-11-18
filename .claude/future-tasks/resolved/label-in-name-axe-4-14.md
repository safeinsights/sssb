# Four framework controls fail "label in name" (axe 4.14), holding axe back

**Priority:** P1 · **Status:** resolved 2026-11-18 (`fix/axe-label-in-name`)

## Resolution

Each control's accessible name now starts with its visible text, in both locales. The hold is lifted:
`@axe-core/playwright` is `^4.14.0` in `apps/showcase/package.json`, and `.github/dependabot.yml` no longer
ignores it.

| Control              | Accessible name now (en / es)                                                                                                                   | How                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `org-switcher`       | "Frontline Desk, switch team" / "Frontline Desk, cambiar equipo"                                                                                | the visible team name, then a visually hidden `org.switchTriggerSuffix`                                                  |
| `user-menu`          | `auth.userMenuLabel`: "{name}, account menu" / "{name}, menú de la cuenta" (full name; the email if it is blank)                                | visually hidden; the initials avatar is `aria-hidden`                                                                    |
| `simulator-pill`     | "Simulator, open the panel"; with unread mail "Simulator, 3 unread emails, open the panel" (es "Simulador, 3 correos sin leer, abrir el panel") | the visible "Simulator", then a visually hidden `simulator.pillSuffix` or `pillUnreadSuffix`; the badge is `aria-hidden` |
| `simulator-collapse` | `simulator.collapseAriaLabel`: "Hide the Simulator panel" / "Ocultar el panel Simulador"                                                        | `aria-label`, now starting with "Hide"                                                                                   |

- **Three of the four are named by their content, not an `aria-label`.** axe 4.14 does not read the
  accessibility tree for this rule. It takes the ON-SCREEN text (`aria-hidden` text included, axe-core's
  `labelContentNameMismatchEvaluate` calling `visibleVirtual` with `screenReader` false), splits both strings
  into words, and needs the visible words, in order, inside the `aria-label`. On these three controls no
  sensible label can pass: the switcher shows "initials + team name", the account menu shows only initials,
  and the pill's label and badge are sibling elements whose text axe joins with no space ("Simulator1"). The
  rule only applies where there is an `aria-label` or `aria-labelledby` (`labelContentNameMismatchMatches`), so
  a content name is outside it. It still meets WCAG 2.5.3, because the name starts with the visible label.
- **The name is built from the visible text where there is any.** The switcher's name is its visible team
  name plus the hidden suffix, and the pill's is its visible "Simulator" plus the hidden suffix, so the name
  cannot drift from the screen (the independent review's suggestion). Only the decorative parts are
  `aria-hidden`: the initials and the pill's badge, whose count the suffix says with a unit.
- Chromium computes "Frontline Desk , switch team" and "Simulator , 3 unread emails, …": `VisuallyHidden` is
  absolutely positioned, which Chromium treats as a block boundary and pads with a space. It is whitespace
  before a comma.
- **Initials are decorative, not a label.** They are WCAG 2.5.3's "symbolic text characters" case, like a "B"
  on a Bold button. The account menu's name carries the user's full name, as this task suggested; a
  voice-control user says "click Dana", not "click DO". A checker that compares the computed name rather than
  an `aria-label` (ACT rule 2ee8b8) may still flag the account menu. `PreviewRow`'s avatar is `aria-hidden`
  everywhere, so the switcher's menu items and the account menu's header no longer read the initials before
  the name ("FD Frontline Desk").
- **The pill's badge uses `useFormatter().number`,** the same locale rules as the ICU `#` in its name, so the
  digits match: "1,000" in en, "1000" in es (run through next-intl's `createTranslator` and `createFormatter`).
  The notification bell was left alone. Its label's plain `{count}` renders "1000" with no grouping, which is what
  its badge shows; formatting the badge would have broken that.
- Catalog: `org.switchTriggerSuffix`, `simulator.pillSuffix` and `simulator.pillUnreadSuffix` are new;
  `simulator.pillAriaLabel` is gone; `auth.userMenuLabel` gained a `{name}` placeholder. A plural branch must
  not start with a word, or the parity test (`packages/kit/src/i18n/messages-parity.test.ts`, `icuArgs`) reads
  it as a placeholder, so the branches start with `#`.
- Opening the panel from the pill, or hiding it, drops keyboard focus; found by the keyboard pass, already
  on main, and recorded as `.claude/future-tasks/simulator-panel-focus-on-toggle.md`.
- Proof: the 12 tests that failed on 4.14 (ten in `a11y.spec.ts`, both locales of `smoke.spec.ts`) pass on
  4.14.0, with the rest of both files. Putting the switcher's old `aria-label` back turned nine of them red
  on this rule, and they went green again with it removed.

## What was true

axe-core 4.14.0 (2026-10-05) turned `label-content-name-mismatch` on by default. The rule checks WCAG
2.5.3 "Label in Name" (Level A): a control's accessible name must contain its visible text, so a voice
control user can say what they see. Four framework controls fail it. In each, an `aria-label` replaces
the visible text instead of containing it:

| Control (test id)    | Component                                                   | Visible text                                                     | Accessible name (en / es)                                                      |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `org-switcher`       | `packages/kit/src/components/auth/org-switcher.tsx`         | the active team's name                                           | `switchLabel`: "Switch team" / "Cambiar equipo"                                |
| `user-menu`          | `packages/kit/src/components/auth/user-menu.tsx`            | the avatar's initials                                            | `userMenuLabel`: "Account menu" / "Menú de la cuenta"                          |
| `simulator-pill`     | `packages/kit/src/components/simulator/simulator-panel.tsx` | `pillLabel` "Simulator", plus the unread badge when there is one | `pillAriaLabel`: "Open the Simulator panel" / "Abrir el panel Simulador"       |
| `simulator-collapse` | `packages/kit/src/components/simulator/simulator-panel.tsx` | `collapseButton` "Hide" / "Ocultar"                              | `collapseAriaLabel`: "Close the Simulator panel" / "Cerrar el panel Simulador" |

The strings live in SSSB's framework catalog, `packages/kit/src/i18n/messages/{en,es}.json`.

**Where it showed up.** The catch-up of October's Dependabot group (`deps/catch-up-2026-11`) took
`@axe-core/playwright` 4.14.0. 12 showcase e2e tests then failed on this one rule and no other: ten in
`a11y.spec.ts` (four admin pages, five Simulator tabs, the restricted dashboard) and both locales of
`smoke.spec.ts`. Only the showcase runs axe.
`@axe-core/playwright` is held at `~4.12.1`, which pins `axe-core ~4.12.1`, until this is fixed (see the
decision-log entry of 2026-11-16). Every Dependabot group that bumps it will fail the same way until then.

**Design to settle, then build.**

- Give each control an accessible name that starts with its visible text, in both locales. For example
  "Acme — switch team" for the switcher, or keep the visible text as the name and move the purpose to
  `aria-description`/`aria-describedby`. The initials-only avatar may be better as a name with the user's
  name in it than with the initials.
- No e2e locator matched these four names on 2026-11-16; the specs find the controls by test id. Re-check
  before renaming, since a role-name locator matches by substring.
- Run `/a11y-review` on the change, then lift the hold: set `@axe-core/playwright` back to a caret range
  in `apps/showcase/package.json` and confirm `a11y.spec.ts` and `smoke.spec.ts` are green.
