// THE RELEASE STAMP (ADR-0014 part 5, step P13): writes `dist/release.json`, `{ "commit": "<40-hex>" }`, the commit
// this package is packed from. The package's `prepack` runs it after build-testing-e2e.mjs (which empties `dist/`).
//
//   node scripts/stamp-release.mjs
//
// `sssb doctor` compares it with the commit an adopter's workspace pins SSSB's reusable workflow at
// (`.github/workflows/*.yml`'s `uses: …/app-checks.yml@<sha>`) and the plugin's marketplace at (`.claude/settings.json`),
// and REPORTS a difference, never fails on it. `@sssb/create`, packed from the same checkout, pins both to the same
// commit, which pack and consume checks. Inside this repository nothing reads the stamp: the kit there is source,
// doctor runs in in-repo mode and says it has no stamp (a `dist/` left behind by a pack is not read).
//
// The stamp names HEAD, and the shipped sources must be HEAD's: packing refuses a `src/` or `package.json` that differs
// from it (staged or not, or with an untracked file), as @sssb/create's prepack refuses a starter that does, under the
// same switch: SSSB_CREATE_UNPUSHED_PIN=1 turns the refusal into a warning, for a tarball no adopter installs (pack and
// consume's, but on a push to SSSB's own repository). Whether HEAD is on GitHub is the generator's check, not this
// one's: the stamp pins nothing GitHub must resolve, and the generator's pin, which must, is the same commit.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAMP = path.join(KIT, 'dist', 'release.json')
/** @sssb/create's switch (packages/create/src/template.js, UNPUSHED_PIN_ENV): one for every package packed together. */
const UNPUSHED_PIN_ENV = 'SSSB_CREATE_UNPUSHED_PIN'
/** What ships from the working tree, which must be the stamped commit's. `dist/` is built here and gitignored. */
const SHIPPED = ['src', 'package.json']

const fail = (/** @type {string} */ message) => {
    process.stderr.write(`stamp-release: FAILED: ${message}\n`)
    process.exit(1)
}

/** @param {string[]} args */
const git = (args) => {
    try {
        return execFileSync('git', args, { cwd: KIT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
        const err = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (error)
        return fail(
            `\`git ${args.join(' ')}\` failed in ${KIT}: ${err.code === 'ENOENT' ? 'git is not installed' : (err.stderr ?? '').trim() || err.message}. ` +
                'The stamp names the commit the package is packed from, so it is packed from a git checkout',
        )
    }
}

const commit = git(['rev-parse', 'HEAD']).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`HEAD is ${commit}, not a commit SHA`)
const changed = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...SHIPPED])
    .split('\0')
    // A rename's entry is followed by its old path, which has no status of its own. Paths are the repository's.
    .filter((entry) => /^[ MADRCU?!]{2} /.test(entry))
    .map((entry) => entry.slice(3))
if (changed.length > 0) {
    const problem = `the shipped sources differ from HEAD (${commit}), which the stamp names:\n  ${changed.join('\n  ')}`
    if (process.env[UNPUSHED_PIN_ENV] !== '1')
        fail(`${problem}\nCommit them first, or set ${UNPUSHED_PIN_ENV}=1 for a tarball no adopter installs.`)
    process.stderr.write(`stamp-release: WARNING (${UNPUSHED_PIN_ENV}=1): ${problem}\n`)
}
mkdirSync(path.dirname(STAMP), { recursive: true })
writeFileSync(STAMP, `${JSON.stringify({ commit })}\n`)
process.stdout.write(`stamp-release: ${path.relative(KIT, STAMP)} names ${commit}\n`)
