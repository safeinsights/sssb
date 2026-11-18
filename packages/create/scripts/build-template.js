// @ts-check
// The package's `prepack` and `postpack`: builds template/ from SSSB's repository, which `files` then packs, and
// removes it after, so no copy of the starter is left in the working tree (or ever committed; .gitignore names it).
//
//   node scripts/build-template.js           build template/ (the workflow pin is the repository's HEAD)
//   node scripts/build-template.js --clean   remove it
import { rmSync } from 'node:fs'
import path from 'node:path'
import { buildTemplate } from '../src/template.js'

const PACKAGE = path.resolve(import.meta.dirname, '..')
const outDir = path.join(PACKAGE, 'template')

if (process.argv.includes('--clean')) {
    rmSync(outDir, { recursive: true, force: true })
} else {
    const meta = buildTemplate({ repoRoot: path.resolve(PACKAGE, '..', '..'), outDir })
    console.log(
        `@sssb/create ${meta.version}: template built, pinning ${meta.workflow.repository}@${meta.workflow.ref}`,
    )
}
