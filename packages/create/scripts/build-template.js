// @ts-check
// The package's `prepack` and `postpack`: builds template/ from SSSB's repository, which `files` then packs, and
// removes it after, so no copy of the starter is left in the working tree (or ever committed; .gitignore names it).
//
//   node scripts/build-template.js           build template/ (the workflow pin is the repository's HEAD)
//   node scripts/build-template.js --clean   remove it
//
// The pin must be on GitHub, or every workspace generated from the tarball fails its first CI run: packing refuses a
// HEAD that no remote-tracking branch of SSSB's GitHub remote contains, unless SSSB_CREATE_UNPUSHED_PIN=1 (a tarball
// that never meets GitHub's runners, as pack and consume's).
import { rmSync } from 'node:fs'
import path from 'node:path'
import { CreateError } from '../src/args.js'
import { buildTemplate, UNPUSHED_PIN_ENV, unpushedPin } from '../src/template.js'

const PACKAGE = path.resolve(import.meta.dirname, '..')
const outDir = path.join(PACKAGE, 'template')

/** @returns {number} */
function build() {
    const repoRoot = path.resolve(PACKAGE, '..', '..')
    const meta = buildTemplate({
        repoRoot,
        outDir,
        warn: (message) => console.warn(`@sssb/create prepack: ${message}`),
    })
    const problem = unpushedPin({ repoRoot, ref: meta.workflow.ref, repository: meta.workflow.repository })
    if (problem && process.env[UNPUSHED_PIN_ENV] !== '1') {
        rmSync(outDir, { recursive: true, force: true })
        console.error(
            `@sssb/create prepack: ${problem}.\nPush the commit first, or set ${UNPUSHED_PIN_ENV}=1 for a tarball no ` +
                "workspace will run on GitHub (pack and consume's).",
        )
        return 1
    }
    if (problem) console.warn(`@sssb/create prepack: WARNING (${UNPUSHED_PIN_ENV}=1): ${problem}`)
    console.log(
        `@sssb/create ${meta.version}: template built, pinning ${meta.workflow.repository}@${meta.workflow.ref}`,
    )
    return 0
}

if (process.argv.includes('--clean')) {
    rmSync(outDir, { recursive: true, force: true })
} else {
    try {
        process.exitCode = build()
    } catch (error) {
        if (!(error instanceof CreateError)) throw error
        rmSync(outDir, { recursive: true, force: true })
        console.error(`@sssb/create prepack: ${error.message}`)
        process.exitCode = 1
    }
}
