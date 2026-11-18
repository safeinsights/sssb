// @ts-check
// `sssb guide [--out <file>] [--check]`: copies the app guide that @sssb/kit ships (the rules an app author follows:
// the seam, vendor SDKs, getDb, i18n, router-agnostic screens, hermetic dev) into the repository, with a hash of its
// content stamped in a header line. The adopter's own CLAUDE.md imports that copy with Claude Code's `@path` import.
//
// THE TRUST DECISION (ADR-0014 part 9): agent instructions steer every agent working in the repository, so a change
// to them must arrive as a reviewable diff in the adopter's own PR, never silently through node_modules. `--check`
// (and, from P5, `sssb doctor`) fails when the stamped hash differs from the installed guide's, so an upgrade is not
// finished until the copy is refreshed and the change sits in the adopter's diff. The hash, not the bytes, is
// compared, so the adopter's formatter cannot make the copy look stale.
//
// The guide is the framework's published subpath `@sssb/kit/guide.md`, resolved from the app's directory through the
// shared resolver (rule 4). The framework starts shipping it at ADR-0014's P7; before that this command says so.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readJson, takeAppDir, takeFlag, takeOption, UsageError, workspaceRootOf } from '../app.js'
import { kitDirOf, resolveAppsKit } from '../kit.js'

const STAMP = /^<!-- sssb-guide sha256:([0-9a-f]{64}) /

/** @param {string | Buffer} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** @param {string[]} args */
export async function run(args) {
    const appDir = takeAppDir(args)
    const check = takeFlag(args, '--check')
    const out = takeOption(args, '--out')
    if (args.length > 0) throw new UsageError('usage: sssb guide [--app <dir>] [--out <file>] [--check]')
    const target = path.resolve(out ?? path.join(workspaceRootOf(appDir), '.claude', 'sssb-guide.md'))

    const kitDir = kitDirOf(appDir)
    const version = readJson(path.join(kitDir, 'package.json')).version
    let guide
    try {
        guide = resolveAppsKit(appDir, 'guide.md')
    } catch (error) {
        throw new UsageError(
            `sssb guide: the @sssb/kit ${version} this app installs ships no app guide (\`@sssb/kit/guide.md\`); ` +
                `it arrives with ADR-0014's P7 (${error instanceof Error ? error.message : String(error)})`,
        )
    }
    const body = readFileSync(guide)
    const hash = sha256(body)

    if (check) {
        const stamped = existsSync(target) ? STAMP.exec(readFileSync(target, 'utf8'))?.[1] : undefined
        if (stamped === hash) {
            console.log(`sssb guide: ${path.relative(process.cwd(), target)} matches @sssb/kit ${version}'s guide`)
            return 0
        }
        console.error(
            stamped === undefined
                ? `sssb guide: ${target} is missing or carries no stamp. Run \`pnpm exec sssb guide\` and commit the copy.`
                : `sssb guide: ${target} was copied from a different guide than @sssb/kit ${version} ships. Run ` +
                      '`pnpm exec sssb guide`, review the diff, and commit it with the upgrade.',
        )
        return 1
    }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
        target,
        `<!-- sssb-guide sha256:${hash} (copied from @sssb/kit ${version} by \`sssb guide\`: edit nothing here; ` +
            'rerun it after an upgrade and review the diff) -->\n\n' +
            body.toString('utf8'),
    )
    console.log(`sssb guide: wrote ${path.relative(process.cwd(), target)} from @sssb/kit ${version}`)
    return 0
}
