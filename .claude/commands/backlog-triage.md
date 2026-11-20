---
description: Curate SSSB's issue backlog - triage new issues, close what is done or obsolete, re-verify stale ones, re-rank Do next
---

Curate the backlog: `safeinsights/sssb`'s open issues, ranked on the
[SSSB backlog Project](https://github.com/orgs/safeinsights/projects). Run it every couple of weeks, after a release,
or when asked. It changes issues and the Project, never code. `$ARGUMENTS` may narrow it (a label, `inbox`, `stale`).

The rules it enforces are `CLAUDE.md`'s "Backlog" bullets; read them first.

1. **Read the state.** `gh issue list -R safeinsights/sssb --state open --limit 300 --json
number,title,labels,issueType,updatedAt,body` and the Project's items with their Status
   (`gh project item-list <n> --owner safeinsights --format json`). The last triage's date is the `Last triaged:` line in
   the Project's README (`gh project view <n> --owner safeinsights`).

2. **Inbox.** An issue missing a type, a `P0`-`P3` label or an `area:*` label, or not on the Project, or on it with no
   Status: classify it (type Bug/Feature/Task, priority, one or two areas, `needs-decision`/`security` when they
   apply), add it to the Project, and give it a Status: `Backlog`, or `Needs decision` with the `needs-decision`
   label. Rewrite a title that does not say the problem or the change.

3. **Done or obsolete since the last triage.** For each commit on `main` and the integration branches since then
   (`git log --oneline --since=<date> origin/main origin/integration`), find the open issues it may settle: by `#N`
   in the message or PR, and by the paths, symbols and config keys the issue cites. Close only with evidence, as a
   comment naming the commit and what it changed: `--reason completed` when the work landed, `--reason "not planned"`
   when the premise no longer holds. When the issue is only partly done, edit its body to what is left and say so in a
   comment instead.

4. **Re-verify a rotation of stale ones.** Take the ten open issues with the oldest `updatedAt` (more when asked).
   Check every factual claim against today's tree: paths, symbols, behaviour, quoted numbers (re-measure the cheap
   ones). Fix drift in the body, close what is obsolete (step 3's evidence rule), and leave a one-line
   `Backlog triage: re-verified, nothing changed` comment on the rest, so the rotation moves on. Fan this out to
   read-only subagents (`model: sonnet`), a few issues each; review what they return before editing anything.

5. **Duplicates and splits.** Two issues for one piece of work: keep the clearer one, fold the other's facts into it,
   close the other as a duplicate (`gh issue close <n> --reason "not planned" --comment "Duplicate of #<m>"`). One
   issue bundling independent pieces: file the pieces, link them from the original, close it.

6. **Re-rank.** The Project's `Do next` status, in row order, is what to work on now: five to ten items, highest
   priority first, unblocked ones only (nothing labelled `needs-decision`). Move finished or blocked rows out of it
   and promote from `Backlog`. A priority you change gets a one-line reason in a comment.

7. **Record and report.** Set the Project README's `Last triaged:` line to today
   (`gh project edit <n> --owner safeinsights --readme ...`, keeping the rest of the README). Report to the
   maintainer: what was filed, closed (with evidence), rewritten and re-ranked, and the `needs-decision` issues as one
   list of questions only the maintainer can answer.

**Every issue is public**, its edit history too. Before writing or editing any body or comment: no adopter named or
identifiable (say "an adopter" or "an app that ..."; the dependency points from adopters to SSSB, never back), no
people by name (say "the maintainer"), no private hosts, account ids, ARNs, buckets, emails, home-directory paths or
private repositories. Fix such text in an existing issue by rewriting it, and tell the maintainer, since the old text
stays in the edit history.

Never close a `needs-decision` issue on your own judgement, never close without evidence, and never touch code from
this command: a fix you notice is a new issue, or a separate session.
