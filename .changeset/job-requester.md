---
'@sssb/kit': minor
'@sssb/create': minor
---

### A job records who started it, and its end reaches them when the team has no admin

**Kind.** migration

**Action.** optional

**What changed.** Framework migration `0017_job_requester` adds a nullable `requested_by` column to `jobs`.
`submitJob` (`@sssb/kit/db/jobs`) takes an optional `requestedBy`, the submitting person's user id. A job's end still
notifies its team's active admins; when the team has none, it now notifies the person who submitted it, while the auth
port still gives them standing in the org. A fixed org source (`AUTH_ORG_SOURCE=fixed`) lists no members, so there a
job's end reaches only its requester. SSSB's rules let neither of that source's roles submit a `Job`, so such a job is
one the app's own rules let the person start. A job submitted without `requestedBy`, a scheduled run among them, still
reaches no one when the team has no admin.

The app guide and `/sssb:new-job` say so.

**To adopt.** Run your migrations, as every release asks. Pass `requestedBy: user.id` to `submitJob` wherever a person
submits a job:

```ts
await submitJob(db, jobs, { tenantId, orgId, kind, payload, requestedBy: user.id })
```
