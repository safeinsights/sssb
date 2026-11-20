---
'@sssb/kit': minor
---

### Ports refuse input they used to pass through

**Kind.** seam

**Action.** required

**What changed.**

- Email: the real adapter and the fake both refuse a `to` that is not exactly one address (blank, a comma, a semicolon, a control character such as a line break, or other than one `@`) and a `subject` with a line break. The vendor reads a comma as a list, and the
  fake hid it. `Ada Lovelace <ada@example.test>` still sends; a display name that contains a comma does not.
  `sendTemplate` turns line breaks in a composed subject into spaces.
- Auth: `updateProfile` refuses, in both adapters, a `name` that is not a non-blank string of at most 256
  characters (a `ForbiddenError`, a 403 through `withPortErrors`), and an unknown or empty locale before it writes
  anything. The fake stores only `name` and `locale`; it used to store the whole object it was handed.
- Auth, real adapter: a membership or invitation with no role, or one the app does not know, is `guest` in the member list and the org switcher,
  as the session already treated it (it listed as `member`). Member, invitation and membership lists are read past
  the first hundred.
- Jobs, in-process runner: the scheduled sweep fails a job still `queued` after five minutes ("lost: never
  started") and notifies its org. Such a job, whose `start()` failed or never ran, used to stay queued for ever.
- Inbound email: `normalizeEmailAddress` (`@sssb/kit/core/inbound-email`) reads the last angle-bracketed part of a
  `From`, the address itself. It read the first, so a display name holding a member's address in angle brackets was
  matched as that member.
- `ProfileScreen` requires a display name within that limit, and shows a translated error when `onSave` rejects.
  New framework keys: `profile.nameRequired`, `profile.nameTooLong`, `profile.saveError`.
- `PeoplePicker`'s `onPick` may return `Promise<boolean | void>`; a resolved `false` or a rejection clears the
  spinner.

**To adopt.** Send one message per recipient, and validate an address a person typed before the port sees it: the port's refusal is a plain `Error`, a 500 through `withPortErrors`. Validate a profile name in your route before the port sees it, and
let your profile glue reject on a failed save. Before switching a deployment's `JOBS_RUNNER` from `codebuild` to
`in-process`, let its builds finish: the sweep would fail their jobs after five minutes.
