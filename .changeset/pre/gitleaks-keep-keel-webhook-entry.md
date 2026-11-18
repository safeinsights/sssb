---
'@sssb/kit': minor
---

### Correction: keep the `.gitleaks.toml` entry for keel's `webhook.test.ts`

**Kind.** scaffold

**Action.** required

**What changed.** v0.2.0-rc.0's notes ("Since keel 24b0589: scaffold changes to apply by hand", under `.gitleaks.toml`)
said to remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` along with the directory.
That was wrong for a workspace that was forked from keel: CI's gitleaks scans the whole history, not the tree
(`gitleaks git` over a checkout with `fetch-depth: 0`), and the commits that hold that file still carry its
placeholder secret, so a scan without the entry reports it. Deleting the directory takes the file out of the tree,
not out of history. A workspace `pnpm create @sssb` generated has no keel history and no such entry.

**To adopt.** Keep the entry, scoped as it was (`condition = "AND"`, the path and the one string), and say in its
comment that it covers history only, so nobody removes it later because the file is gone. If you removed it, restore
it:

```toml
# History only: packages/keel is gone from the tree, but its webhook.test.ts and the placeholder secret below are
# still in this repository's history, which gitleaks scans.
[[allowlists]]
description = "keel's webhook.test.ts WEBHOOK_SECRET fixture, in history only"
condition = "AND"
paths = ['''packages/keel/src/service-auth/webhook\.test\.ts''']
regexes = ['''env-secret-abcdef0123456789''']
regexTarget = "line"
```

The rest of that item stands: give any entry of the app's own that pairs `paths` with `regexes` `condition = "AND"`.
