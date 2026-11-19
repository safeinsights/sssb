---
'@sssb/kit': minor
'@sssb/cdk': minor
---

### Real mode requires only the optional ports your app uses

**Kind.** operator

**Action.** optional

**What changed.** Each of SSSB's optional ports has a switch the server reads at boot: `LLM_PROVIDER` (`anthropic`
or `none`), `EMAIL_PROVIDER` (`mailgun` or `none`), `INBOUND_EMAIL_PROVIDER` (`mailgun` or `none`) and `JOBS_RUNNER`
(`codebuild`, `in-process` or `none`). A port switched to `none` is absent: real mode no longer requires its settings
(`ANTHROPIC_API_KEY`; `MAILGUN_DOMAIN`, `MAILGUN_API_KEY`, `EMAIL_FROM`; `MAILGUN_WEBHOOK_SIGNING_KEY`;
`JOBS_CODEBUILD_PROJECT`), never loads its SDK, and a call through it throws an error naming the switch. An unset
switch is its first value, so a deployment that sets none requires exactly what it did. `SssbApp` sets the switches
from a new, optional `params.ports` (`llm`, `email`, `inboundEmail`, `jobs`), and refuses a port or a value it does not
know. `required-env.json` now also lists what each choice requires.

**To adopt.** Add `ports` to `apps/<app>/config/params.ts`, beside `database`, with `none` for each port your app
does not use, e.g. `ports: { llm: 'none', email: 'none', inboundEmail: 'none', jobs: 'in-process' }`; `SssbApp`
already receives `params`. A deployment that does not use `SssbApp` sets the variables itself. Then delete the
placeholder values you set for the ports you switched off.

**Now deletable.** Placeholder values (`unused`, `unused-by-<app>`) set for `ANTHROPIC_API_KEY`, the Mailgun
variables, `EMAIL_FROM` or `JOBS_CODEBUILD_PROJECT` only so that real mode would start.
