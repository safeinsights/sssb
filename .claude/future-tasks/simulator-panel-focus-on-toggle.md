# Opening or hiding the Simulator panel drops keyboard focus

**Priority:** P2 · **Status:** open
**Found by:** the `/a11y-review` keyboard pass on `fix/axe-label-in-name`, 2026-11-18.

## What happens

`packages/kit/src/components/simulator/simulator-panel.tsx` toggles between two controls. The collapsed state
renders the `simulator-pill`; the expanded state renders the panel with its `simulator-collapse` ("Hide") button,
and the pill is not rendered at all.

- Press Enter on the focused pill: the panel opens, the pill unmounts, and focus falls to `<body>`.
- Press Enter on the focused Hide button: the panel gets `display: none`, and focus falls to `<body>` again.

Measured in Chromium with a keyboard-only Playwright pass: `document.activeElement` was `BODY` after each. A
keyboard or screen-reader user then starts again from the top of the page. That fails WCAG 2.4.3 Focus Order (Level
A) in spirit: the next Tab does not continue from the control they used. axe does not see it.

## Design

After a toggle by the user, move focus to the control that replaces the one they used: the Hide button when the
panel opens, the pill when it closes. Do it in an effect keyed on `collapsed` and gated on a ref set by `toggle()`,
so the panel's first render and a restored collapsed state from `localStorage` never steal focus on page load.
Keep the coachmark's dismiss button out of it. Pin both directions in `apps/showcase/tests/e2e/simulator-panel.spec.ts`
(`toBeFocused()` after `keyboard.press('Enter')`), and see the spec fail with the effect removed.

The Simulator panel is also getting a ticker control (`simulator-ticker-control.md`); either can land first.
