/**
 * `pnpm release-app <create|verify|bypass>`, and `pnpm release-app:init` for `create`. Run by an owner of the
 * safeinsights organisation, in a terminal; docs/runbooks/release-app.md is the procedure. The work is in
 * scripts/release-app/commands.ts; this file only reads the command line and wires in the real world.
 *
 *   create [--name <display name>] [--apply-bypass]
 *       Create the App by the manifest flow, store its key and client id in the `release` environment,
 *       read the installation back, and show the ruleset changes (made only with --apply-bypass, after
 *       you type "apply").
 *   verify --app-id <id> [--key-stdin]
 *       Check everything and change nothing. With --key-stdin (a PEM on standard input, for example a key
 *       freshly generated on the App's page), also read the App and its installation back as the App.
 *   bypass --app-id <id> [--apply]
 *       Show the ruleset changes for an existing App, and make them with --apply.
 */
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { bypassCommand, createCommand, verifyCommand, type Deps } from './release-app/commands'
import { redact, runGh } from './release-app/github'

/**
 * One line at a time from stdin, through ONE readline interface for the whole run: a fresh interface per
 * question loses lines that were already buffered. `null` once input has ended.
 */
function lineReader(): (question: string) => Promise<string | null> {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
    const queued: string[] = []
    const waiting: ((line: string | null) => void)[] = []
    let closed = false
    rl.on('line', (line) => {
        const next = waiting.shift()
        if (next) next(line)
        else queued.push(line)
    })
    rl.on('close', () => {
        closed = true
        for (const next of waiting.splice(0)) next(null)
    })
    return (question) => {
        process.stdout.write(`${question}\n> `)
        if (queued.length > 0) return Promise.resolve(queued.shift() ?? null)
        if (closed) return Promise.resolve(null)
        return new Promise((resolve) => waiting.push(resolve))
    }
}

async function readStdin(): Promise<string> {
    let text = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) text += chunk
    return text
}

function appIdOf(value: string | undefined): number | null {
    return value !== undefined && /^[1-9][0-9]*$/.test(value) ? Number(value) : null
}

async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv
    const { values } = parseArgs({
        args: rest,
        options: {
            name: { type: 'string' },
            'apply-bypass': { type: 'boolean', default: false },
            'app-id': { type: 'string' },
            'key-stdin': { type: 'boolean', default: false },
            apply: { type: 'boolean', default: false },
        },
        strict: true,
    })
    const keyFromStdin = command === 'verify' && values['key-stdin']
    const deps: Deps = {
        fetch: globalThis.fetch,
        gh: runGh,
        io: {
            out: (text) => console.log(text),
            err: (text) => console.error(text),
            // `verify --key-stdin` consumes stdin for the key, and asks nothing.
            ask: keyFromStdin ? async () => null : lineReader(),
        },
        isTTY: process.stdin.isTTY === true,
        tmpRoot: tmpdir(),
    }

    if (command === 'create') {
        return createCommand(deps, { name: values.name, applyBypass: values['apply-bypass'] })
    }
    if (command === 'verify' || command === 'bypass') {
        const appId = appIdOf(values['app-id'])
        if (appId === null) {
            console.error("Pass --app-id <id>: the App's numeric id, from its settings page (not the client id).")
            return 1
        }
        if (command === 'bypass') return bypassCommand(deps, { appId, apply: values.apply })
        const privateKey = keyFromStdin ? (await readStdin()).trim() : undefined
        if (keyFromStdin && !privateKey) {
            console.error('--key-stdin was given but standard input was empty.')
            return 1
        }
        return verifyCommand(deps, { appId, privateKey })
    }
    console.error('Usage: pnpm release-app <create|verify|bypass> (see scripts/release-app.ts)')
    return 1
}

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
        console.error(redact(err instanceof Error ? err.message : String(err)))
        process.exit(1)
    },
)
