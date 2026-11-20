---
'@sssb/kit': minor
---

### Ports refuse input they used to pass through

**Kind.** seam

**Action.** required

**What changed.**

- Email: a `to` is a bare address (`ada@example.test`) or a display name followed by one bracketed address at its
  end (`Ada Lovelace <ada@example.test>`). The real adapter and the fake both refuse anything else: blank, a comma, a
  semicolon, a control character such as a line break, `a<b@c.d>`, a trailing `(comment)`, and a quoted display name
  such as `"Ada" <ada@example.test>`. They also refuse a `subject` with a line break. The vendor reads a comma as a
  list, and the fake hid it.
  `sendTemplate` turns line breaks in a composed subject into spaces.
- Auth: `updateProfile` refuses, in both adapters, a `name` that is not a non-blank string of at most 256
  characters (a `ForbiddenError`, a 403 through `withPortErrors`), and an unknown or empty locale before it writes
  anything. The fake stores only `name` and `locale`; it used to store the whole object it was handed. Accepting an
  invitation in the fake holds the name to the same rule.
- Auth, real adapter: a membership or invitation with no role, or one the app does not know, is `guest` in the member list and the org switcher,
  as the session already treated it (it listed as `member`). Member, invitation and membership lists are read past
  the first hundred.
- Jobs, in-process runner: the scheduled sweep fails a job still `queued` after five minutes ("lost: never
  started") and notifies its org. Such a job, whose `start()` failed or never ran, used to stay queued for ever.
- Inbound email: `normalizeEmailAddress` (`@sssb/kit/core/inbound-email`) fails closed. It ignores a quoted display
  name, so a display name holding a member's address cannot supply it, and it answers `''` (no address) for a value
  it cannot read one way only: more than one `<...>`, text or a comment after the `>`, or an unbalanced bracket.
- `ProfileScreen` requires a display name within that limit, and shows a translated error when `onSave` rejects.
  New framework keys: `profile.nameRequired`, `profile.nameTooLong`, `profile.saveError`.
- `PeoplePicker`'s `onPick` may return `Promise<boolean | void>`; a resolved `false` or a rejection clears the
  spinner.

**To adopt.** Send one message per recipient, and validate an address a person typed before the port sees it: the port's refusal is a plain `Error`, a 500 through `withPortErrors`. Validate a profile name in your route before the port sees it, and
let your profile glue reject on a failed save. Before switching a deployment's `JOBS_RUNNER` from `codebuild` to
`in-process`, let its builds finish: the sweep would fail their jobs after five minutes.
