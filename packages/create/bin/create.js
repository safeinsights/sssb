#!/usr/bin/env node
// @ts-check
// `@sssb/create` (ADR-0014, step P12): `pnpm create @sssb <dir>` or `npm create @sssb <dir>`. A new SSSB app workspace
// from the template packed into this package (template/, src/template.js). Run from a checkout of SSSB's repository,
// where nothing was packed, it builds the template from that checkout first.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { CreateError, parseArgs, PLACEHOLDER_OWNER, PLACEHOLDER_REPO, USAGE } from '../src/args.js'
import { generate } from '../src/generate.js'
import { holdSignals, releaseSignals, signalsSettled } from '../src/signals.js'
import { buildTemplate, META_FILE, unpushedPin } from '../src/template.js'

const PACKAGE = path.resolve(import.meta.dirname, '..')

/** @param {import('../src/args.js').Options} options */
async function confirmed(options) {
    if (options.yes || !process.stdin.isTTY) return true
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Create the ${options.name} workspace in ${path.resolve(options.dir)}? [Y/n] `)
    rl.close()
    return !/^n/i.test(answer.trim())
}

/**
 * A path as a POSIX shell reads it back: as it is when it holds nothing the shell would act on, else single-quoted.
 * @param {string} text
 */
const shellQuoted = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`)

/**
 * The template inside a checkout of SSSB's repository, built into a temporary directory that `run` gets and that is
 * removed after, however `run` ends. Warns, loudly, when the commit it pins is not on GitHub: the workspace's first
 * CI run would fail to resolve SSSB's workflow.
 * @template T
 * @param {string | null} workflowRef
 * @param {(templateDir: string) => T} run
 * @returns {T}
 */
function fromCheckout(workflowRef, run) {
    const repoRoot = path.resolve(PACKAGE, '..', '..')
    if (!existsSync(path.join(repoRoot, 'apps', 'starter', 'package.json')))
        throw new CreateError(
            `this package has no template (${path.join(PACKAGE, 'template')}) and is not in SSSB's repository`,
        )
    // Held before the directory is made: a signal during the (synchronous) build would otherwise end the process by
    // its default action, before the `finally` below, and leave the directory in the temporary one (signals.js).
    let scratch = ''
    const undo = () => {
        if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
    holdSignals(undo)
    try {
        scratch = mkdtempSync(path.join(tmpdir(), 'sssb-create-template-'))
        const meta = buildTemplate({
            repoRoot,
            outDir: scratch,
            ...(workflowRef ? { workflowRef } : {}),
            warn: (message) => console.warn(`@sssb/create: ${message}`),
        })
        const problem = unpushedPin({ repoRoot, ref: meta.workflow.ref, repository: meta.workflow.repository })
        if (problem) console.warn(`\n@sssb/create: WARNING: ${problem}. Push it, or pass --workflow-ref <sha>.\n`)
        return run(scratch)
    } finally {
        undo()
        releaseSignals(undo)
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
        console.log(USAGE)
        return 0
    }
    if (!(await confirmed(options))) {
        console.log('nothing written.')
        return 0
    }

    /** @param {string} templateDir */
    const create = (templateDir) =>
        generate({
            templateDir,
            target: options.dir,
            slug: options.slug,
            name: options.name,
            repo: options.repo,
            owners: options.owners,
            sssb: options.sssb,
            workflowRef: options.workflowRef,
        })
    const packed = path.join(PACKAGE, 'template')
    const result = existsSync(path.join(packed, META_FILE)) ? create(packed) : fromCheckout(options.workflowRef, create)
    // A Ctrl-C (or SIGTERM, SIGHUP) that came while the template was built or the workspace written is dispatched
    // before this resolves, undoes them and ends the process (signals.js), before anything says it was created.
    await signalsSettled()

    const fromHere = path.relative(process.cwd(), result.root)
    const relative = fromHere === '' ? '.' : fromHere.startsWith('..') ? result.root : fromHere
    const placeholders = [
        ...(options.repo === null ? [`${PLACEHOLDER_OWNER}/${PLACEHOLDER_REPO} (--repo)`] : []),
        ...(options.owners.length === 0 ? ['the code owner in CODEOWNERS (--owner)'] : []),
    ]
    console.log(`
Created ${options.name} in ${result.root}: ${result.files.length} files, the app in apps/${options.slug}/.

Next:
  cd ${shellQuoted(relative)}
  git init
  pnpm install
  pnpm --filter './apps/*' exec playwright install chromium
  pnpm verify

On GitHub, require the check \`sssb / all-checks\` on your default branch (it fails unless every one of SSSB's
checks ran and passed), and turn on private vulnerability reporting. README.md lists the rest.${
        placeholders.length > 0 ? `\nStill to fill in: ${placeholders.join('; ')}.` : ''
    }`)
    return 0
}

main().then(
    (status) => process.exit(status),
    async (error) => {
        // A failure a signal caused (a Ctrl-C reaches git, which the template build runs, too) ends as that signal.
        await signalsSettled()
        if (error instanceof CreateError) {
            console.error(`@sssb/create: ${error.message}\n\n${USAGE}`)
            process.exit(1)
        }
        throw error
    },
)
