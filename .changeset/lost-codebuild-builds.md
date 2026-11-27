---
'@sssb/kit': minor
---

### The CodeBuild runner notices a lost build

**Kind.** operator

**Action.** optional

**What changed.** A CodeBuild job whose build ended without posting the jobs webhook used to stay queued for ever, and
a kind that retries never retried it. The runner now records each job's build id, and the scheduled tick's sweep asks
CodeBuild (`BatchGetBuilds`) about each job still open and quiet for five minutes. It fails as lost a job whose build
ended that long ago, a job whose build CodeBuild no longer knows, and a job whose start never recorded a build. A
failure arms the next attempt of a kind whose `jobRetry` allows one, and notifies as the jobs webhook does. A build
still in progress is left alone. Jobs written before this release, which have no recorded build, are never judged.

**To adopt.** Allow the server's role `codebuild:BatchGetBuilds` on the job project's builds, beside the
`codebuild:StartBuild` it already has. Without it each tick logs that the sweep could not read builds, and judges
none.
