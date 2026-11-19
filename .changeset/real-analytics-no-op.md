---
'@sssb/kit': patch
---

### A real deployment without a PostHog key no longer writes to disk

**Kind.** operator

**Action.** optional

**What changed.** In real mode without `POSTHOG_KEY`, the analytics port was the simulated world's fake, which writes
each capture and reads each flag under `.data/` in the server's working directory. On Lambda that directory is the
deployment package, which is read-only, so those calls most likely threw, and sending an invite awaits one. It is now a
no-op: nothing is captured, and `isFlagEnabled` answers the default its caller passes, as the PostHog adapter does
when PostHog cannot be reached. With a key, PostHog is unchanged.

**To adopt.** Nothing to change. If your deployment sets no `POSTHOG_KEY`, its analytics calls now do nothing instead
of touching the filesystem; if you set `APP_DATA_DIR` to a writable directory such as `/tmp` to get past this, you
can drop it.

**Now deletable.** An `APP_DATA_DIR` (or a placeholder `POSTHOG_KEY`) set on a real deployment only so that analytics
calls would not fail.
