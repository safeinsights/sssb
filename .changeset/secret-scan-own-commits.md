---
'@sssb/create': patch
---

### The secret scan reads a pull request's own commits, not every branch

**Kind.** scaffold

**Action.** optional

**What changed.** The generated `checks.yml`'s `secret-scan` job passed gitleaks no range, so it read every branch on the
remote: one branch's secret-like string failed the scan on every other open pull request. It now reads a pull request's
own commits (a commit it added and deleted again included) and, on a push to `main`, `main`'s whole history. A new root
file, `.github/scripts/secret-scan-range.sh`, picks the range from the event.

**To adopt.** Copy `.github/scripts/secret-scan-range.sh` from SSSB's repository at this release into the same path in
your workspace, then change the `gitleaks` step of your `checks.yml`'s `secret-scan` job to hand gitleaks the range:

```yaml
- name: gitleaks (pinned binary; gitleaks-action requires a license key for organization repositories)
  env:
      EVENT_NAME: ${{ github.event_name }}
      BASE_SHA: ${{ github.event.pull_request.base.sha }}
      HEAD_SHA: ${{ github.event.pull_request.head.sha }}
  run: |
      # ... the download, the digest check and the unpack, as before ...
      range=$(bash .github/scripts/secret-scan-range.sh)
      ./gitleaks git --redact --config .gitleaks.toml --log-opts="${range:?}"
```

Keep the `range=` line on its own: a failed script then stops the step, where inside the gitleaks command it would not
and gitleaks would run with no range. The script refuses any event but `pull_request` and `push`; if your workflow runs on
another, add its range to the script.

**Now deletable.** An allowlist entry in `.gitleaks.toml` that exists only to silence a finding on another branch.
