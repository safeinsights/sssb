---
'@sssb/kit': patch
---

### Avatar initials skip punctuation

**Kind.** none

**Action.** none

**What changed.** The user menu's avatar and the identity rows (the menu's header, the team switcher) took the first
character of each of the first two words of a name (the first two characters of a one-word name), punctuation
included, so `Ana (Bea) Cruz` showed `A(`. They now show the first letters of the first and last words that start with
a letter, uppercased: `AC`. A one-word name shows one letter, where it showed two. A person with no such word shows
the first letter (or digit) of their email.
