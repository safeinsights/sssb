---
'@sssb/kit': patch
---

### An app with no extra subject fields no longer silences a lint rule

**Kind.** seam

**Action.** optional

**What changed.** `AbilitySubject` in `@sssb/kit/core/abilities` is now an intersection, `AppSubjectFields & { type; orgId?; ownerId? }`, instead of an interface that extends `AppSubjectFields`. The seam's `AppSubjectFields` may therefore be an interface, a type alias or a mapped type. An app with no fields used to declare an empty interface and suppress `@typescript-eslint/no-empty-object-type`, the one place the "empty registration is the off switch" rule was not true; `apps/starter` now writes `export type AppSubjectFields = Record<never, never>`. An app that declares an interface keeps working unchanged, and so does every caller of `AbilitySubject`.

**To adopt.** Nothing breaks if you do nothing. If your `src/app-config/abilities.ts` carries an empty `interface AppSubjectFields {}` under an `eslint-disable-next-line @typescript-eslint/no-empty-object-type`, replace both with `export type AppSubjectFields = Record<never, never>`. Only code that wrote `interface X extends AbilitySubject` is affected, and it needs `type X = AbilitySubject & { … }` instead.

**Now deletable.** An `eslint-disable-next-line @typescript-eslint/no-empty-object-type` above an empty `AppSubjectFields` interface.
