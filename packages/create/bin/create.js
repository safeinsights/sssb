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
import { buildTemplate, META_FILE } from '../src/template.js'

const PACKAGE = path.resolve(import.meta.dirname, '..')

/** @param {import('../src/args.js').Options} options */
async function confirmed(options) {
    if (options.yes || !process.stdin.isTTY) return true
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Create the ${options.name} workspace in ${path.resolve(options.dir)}? [Y/n] `)
    rl.close()
    return !/^n/i.test(answer.trim())
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

    let templateDir = path.join(PACKAGE, 'template')
    /** @type {string | null} */
    let scratch = null
    if (!existsSync(path.join(templateDir, META_FILE))) {
        const repoRoot = path.resolve(PACKAGE, '..', '..')
        if (!existsSync(path.join(repoRoot, 'apps', 'starter', 'package.json')))
            throw new CreateError(`this package has no template (${templateDir}) and is not in SSSB's repository`)
        scratch = mkdtempSync(path.join(tmpdir(), 'sssb-create-template-'))
        templateDir = scratch
        buildTemplate({ repoRoot, outDir: templateDir })
    }
    try {
        const result = generate({
            templateDir,
            target: options.dir,
            slug: options.slug,
            name: options.name,
            repo: options.repo,
            owners: options.owners,
            sssb: options.sssb,
            workflowRef: options.workflowRef,
        })
        const fromHere = path.relative(process.cwd(), result.root)
        const relative = fromHere === '' ? '.' : fromHere.startsWith('..') ? result.root : fromHere
        const placeholders = [
            ...(options.repo === null ? [`${PLACEHOLDER_OWNER}/${PLACEHOLDER_REPO} (--repo)`] : []),
            ...(options.owners.length === 0 ? ['the code owner in CODEOWNERS (--owner)'] : []),
        ]
        console.log(`
Created ${options.name} in ${result.root}: ${result.files.length} files, the app in apps/${options.slug}/.

Next:
  cd ${relative}
  git init
  pnpm install
  pnpm exec playwright install chromium
  pnpm verify

On GitHub, require the check \`sssb / all-checks\` on your default branch (it fails unless every one of SSSB's
checks ran and passed), and turn on private vulnerability reporting. README.md lists the rest.${
            placeholders.length > 0 ? `\nStill to fill in: ${placeholders.join('; ')}.` : ''
        }`)
        return 0
    } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
}

main().then(
    (status) => process.exit(status),
    (error) => {
        if (error instanceof CreateError) {
            console.error(`@sssb/create: ${error.message}\n\n${USAGE}`)
            process.exit(1)
        }
        throw error
    },
)
