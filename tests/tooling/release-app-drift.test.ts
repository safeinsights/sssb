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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
    CLIENT_ID_VARIABLE,
    KEY_SECRET,
    RELEASE_APP_PERMISSIONS,
    RELEASE_ENVIRONMENT,
} from '../../scripts/release-app/manifest'

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url))
const MINT_ACTION = 'actions/create-github-app-token@'

type Step = {
    id?: string
    name?: string
    uses?: string
    run?: string
    with?: Record<string, unknown>
    env?: Record<string, unknown>
}
type Job = { environment?: unknown; steps?: Step[] } & Record<string, unknown>
type Workflow = { jobs: Record<string, Job> } & Record<string, unknown>

/** Commands that need no permission and reach nothing: they run on the runner and stop there. */
const LOCAL_COMMANDS = new Set(['set', 'echo', 'printf', 'base64', 'mktemp', 'true', 'test', '['])

/** git subcommands that touch only the local repository. */
const LOCAL_GIT = new Set(['init', 'rev-parse', 'config', 'tag', 'commit', 'apply', 'add', 'diff', 'status'])

/** `git -c` settings the push may carry. */
const GIT_CONFIG_KEYS = new Set(['core.hooksPath', 'http.extraheader'])

/** The only `git push` options allowed: none of them pushes more refs or rewrites one. */
const PUSH_OPTIONS = new Set(['--no-verify', '--atomic', '-q', '--quiet', '--porcelain'])

/** The refs a push may land on, as written in release.yml, and the remote it may go to. */
const PUSH_DESTINATIONS = new Set(['main', 'refs/heads/main', 'refs/tags/v$VERSION'])
const PUSH_REMOTE = 'https://github.com/$GITHUB_REPOSITORY'

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

/**
 * Split a script into commands, each a list of words with quotes removed. A `$(…)` becomes the word `$(…)`
 * in its command, and its own commands are returned too. Comments run to the end of the line.
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

/** Drop leading `NAME=value` assignments, `{`/`}` groups and redirections (with their targets). */
function significant(command: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < command.length; i++) {
        const w = command[i]
        if (out.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
        if (w === '{' || w === '}' || w === '!') continue
        if (/^[0-9]*>{1,2}&?$|^<$/.test(w)) {
            i++
            continue
        }
        if (/^[0-9]*>{1,2}&?\S|^<\S/.test(w)) continue
        out.push(w)
    }
    return out
}

/** Classify one command of a token-holding step. Pushes a finding for anything it cannot place. */
function classify(words: string[], findings: Finding[]): Operation | null {
    const [program, ...args] = significant(words)
    if (program === undefined) return null
    if (LOCAL_COMMANDS.has(program)) return { command: program, permission: null }
    if (program !== 'git') {
        findings.push(
            `unclassified command \`${words.join(' ')}\` in a step holding the release app's token: name the App ` +
                'permission it needs in this test (and RELEASE_APP_PERMISSIONS), or move it out of that step',
        )
        return null
    }
    let i = 0
    while (i < args.length && args[i].startsWith('-')) {
        if (args[i] === '-C') i += 2
        else if (args[i] === '-c') {
            const key = (args[i + 1] ?? '').split('=')[0]
            if (!GIT_CONFIG_KEYS.has(key)) findings.push(`git -c ${key} is not a setting the push may carry`)
            i += 2
        } else {
            findings.push(`unclassified git option ${args[i]}`)
            i++
        }
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (LOCAL_GIT.has(sub)) return { command: `git ${sub}`, permission: null }
    if (sub === 'fetch') {
        const remote = rest.find((w) => !w.startsWith('-'))
        if (remote === '$GITHUB_WORKSPACE') return { command: 'git fetch (local)', permission: null }
        return { command: 'git fetch', permission: 'contents' }
    }
    if (sub === 'push') {
        const positional = rest.filter((w) => !w.startsWith('-'))
        for (const option of rest.filter((w) => w.startsWith('-'))) {
            if (!PUSH_OPTIONS.has(option))
                findings.push(`git push ${option} is not allowed (only ${[...PUSH_OPTIONS].join(' ')})`)
        }
        const [remote, ...refspecs] = positional
        if (remote !== PUSH_REMOTE) findings.push(`git push goes to ${remote}, not ${PUSH_REMOTE}`)
        if (refspecs.length === 0) findings.push('git push names no refspec, so git decides what it pushes')
        for (const refspec of refspecs) {
            if (refspec.startsWith('+')) findings.push(`git push ${refspec} forces`)
            const [src, dst = src] = refspec.replace(/^\+/, '').split(':')
            if (src === '') findings.push(`git push ${refspec} deletes ${dst}`)
            if (!PUSH_DESTINATIONS.has(dst))
                findings.push(`git push lands on ${dst}, which is not main or the release tag`)
        }
        return { command: 'git push', permission: 'contents' }
    }
    findings.push(`unclassified git subcommand \`git ${sub ?? ''}\` in a step holding the release app's token`)
    return null
}

/** Everything wrong with a workflow, and the permissions its use of the release app forces. */
function audit(workflow: Workflow): { findings: Finding[]; forced: Map<string, string> } {
    const findings: Finding[] = []
    const forced = new Map<string, string>()
    const credential = new RegExp(`\\b(secrets\\.${KEY_SECRET}|vars\\.${CLIENT_ID_VARIABLE})\\b`)

    // 1. Where the key and client id are read.
    const reads = strings(workflow, 'workflow').filter((s) => credential.test(s.text))
    const mints: { job: string; index: number; step: Step }[] = []
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        ;(job.steps ?? []).forEach((step, index) => {
            if (typeof step.uses === 'string' && step.uses.startsWith(MINT_ACTION))
                mints.push({ job: jobName, index, step })
        })
    }
    if (mints.length !== 1) findings.push(`expected exactly one ${MINT_ACTION} step, found ${mints.length}`)
    const mint = mints[0]
    if (!mint) return { findings, forced }
    const mintPath = `workflow.jobs.${mint.job}.steps[${mint.index}].with`
    for (const read of reads) {
        if (!read.at.startsWith(`${mintPath}.`)) findings.push(`${read.at} reads the release app's credentials`)
    }
    const job = workflow.jobs[mint.job]
    if (job.environment !== RELEASE_ENVIRONMENT) {
        findings.push(`job ${mint.job} mints the token outside the "${RELEASE_ENVIRONMENT}" environment`)
    }
    if (typeof mint.step.id !== 'string') {
        findings.push('the mint step has no id, so its token cannot be traced')
        return { findings, forced }
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

    // 3 and 4. Where the token goes, and what each step that holds it does.
    const tokenRef = new RegExp(`steps\\.${mint.step.id}\\.outputs`)
    const all = strings(workflow, 'workflow').filter((s) => tokenRef.test(s.text))
    const consumers = new Set<number>()
    for (const use of all) {
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
    for (const index of consumers) {
        const step = (job.steps ?? [])[index]
        if (typeof step.run !== 'string' || step.uses !== undefined) {
            findings.push(`step ${index} of ${mint.job} holds the token but is not a plain run step`)
            continue
        }
        if (/GITHUB_(ENV|OUTPUT|PATH)\b/.test(step.run)) {
            findings.push(
                `step "${step.name ?? index}" holds the token and writes $GITHUB_ENV, $GITHUB_OUTPUT or $GITHUB_PATH`,
            )
        }
        let commands: string[][]
        try {
            commands = commandsOf(step.run)
        } catch (err) {
            findings.push(`step "${step.name ?? index}": ${(err as Error).message}`)
            continue
        }
        for (const command of commands) {
            const op = classify(command, findings)
            if (op?.permission) forced.set(op.command, op.permission)
        }
    }

    // 6. Both directions.
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

function load(): Workflow {
    return parse(readFileSync(WORKFLOW, 'utf8')) as Workflow
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
            /lands on other/,
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
        }, /jobs\.pack\..*reads the release app's credentials/))
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
    it('a second mint', () =>
        red((w) => {
            w.jobs.pack.steps?.push({ id: 'again', uses: `${MINT_ACTION}v3` })
        }, /exactly one .* step, found 2/))
})
