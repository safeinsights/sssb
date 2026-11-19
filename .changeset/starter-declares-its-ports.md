---
'@sssb/create': patch
---

### The starter declares the optional ports it uses

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `config/params.ts` has a `ports` entry: `llm: 'none'`, `email: 'mailgun'`,
`inboundEmail: 'none'` and `jobs: 'in-process'`, since the starter makes no model call, has no inbound email route and
no jobs webhook route. A workspace generated from now on deploys without an Anthropic key, an inbound signing key or a
CodeBuild project.

**To adopt.** Copy the `ports` entry into your own `config/params.ts`, beside `database`, and set each port to what
your app uses (the entry "Real mode requires only the optional ports your app uses" lists the values).
