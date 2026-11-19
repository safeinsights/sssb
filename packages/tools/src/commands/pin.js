// @ts-check
// `sssb pin [--app <dir>]`: raises both of a workspace's pins on SSSB to the installed `@sssb/kit`'s release commit
// (adoption review follow-up 7). An adopter keeps two pins on one commit of SSSB's repository: the reusable workflow's
// `uses: <owner>/<name>/.github/workflows/app-checks.yml@<sha>` in `.github/workflows/*.yml`, and the plugin marketplace's
// `ref` in `.claude/settings.json`. `sssb doctor` reports the pins that are not the commit the kit's stamp
// (`dist/release.json`) names; this command writes them, so an upgrade maintains one version, the npm one.
//
//   - Idempotent: a pin already on the commit is left byte for byte as it was, and the run says so.
//   - It says what it changed, file and line, with the commit it replaced.
//   - It refuses, and writes nothing, when there is no commit to pin to (SSSB's own repository, where the kit is source,
//     or a kit packed by hand without a stamp), or when the workspace's files are not the shape it can edit: no workflow
//     calls SSSB's reusable workflow, `.claude/settings.json` is not JSON or declares no marketplace from SSSB's
//     repository. Every pin is judged before the first file is written.
//   - A `.claude/settings.json` that is missing is not a refusal, as it is not one for doctor: a workspace whose people do
//     not use Claude Code has no plugin and so no second pin. Its workflow pin is raised and the run says so.
//
// The edit is made on the file's text, so what else is in the file, its formatting included, is untouched. The pin is a
// commit's SHA, never the release's tag, which can be moved (ADR-0014 part 7).
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readJson, takeAppDir, UsageError, workspaceApps, workspaceRootOf } from '../app.js'
import { kitDirOf, kitReleaseStampOf, kitVersionOf } from '../kit.js'
import { githubRepositoryOf, isInRepoKit, sourceRepository, stampedCommit, WORKFLOW_USES } from './doctor-checks.js'

const SETTINGS = '.claude/settings.json'

/**
 * @typedef {{ file: string, line?: number, what: string, from: string | null, to: string, comment?: true }} Change one
 *   pin: where it is, and the ref it had (null: none) and has; `comment`: only the version in its trailing comment moved
 * @typedef {{ file: string, text: string }} SourceFile a file of the workspace, by the path shown for it, and its text
 * @typedef {{ file: string, text: string, changes: Change[] }} Edited a file with the pins in it, `text` as it will be
 *   (the text it was, when no pin in it moves)
 */

/**
 * The version in a trailing comment after a workflow pin, in the forms the generator (`# @sssb/create 0.2.0`) and the
 * earlier release notes (`# v0.2.0`) wrote, and `# @sssb/kit 0.2.0`, moved to `version`; any other comment, which is the adopter's, as it was.
 * @param {string} rest what follows the ref on the `uses:` line
 * @param {string} version
 */
function withVersionComment(rest, version) {
    return rest.replace(/^(['"]?\s+#\s*(?:@sssb\/(?:create|kit)\s+|v))\d[\w.+-]*(\s*)$/, `$1${version}$2`)
}

/**
 * The workflow files' pins of `repository`'s reusable workflows, moved to `commit`.
 * @param {SourceFile[]} workflows
 * @param {string} repository `owner/name`, lowercased
 * @param {string} commit
 * @param {string} version the kit's, for a comment that names it
 * @returns {Edited[]}
 */
function raiseWorkflowPins(workflows, repository, commit, version) {
    /** @type {Edited[]} */
    const edited = []
    for (const { file, text } of workflows) {
        /** @type {Change[]} */
        const changes = []
        const lines = text.split('\n').map((line, index) => {
            const match = WORKFLOW_USES.exec(line)
            if (match?.[2]?.toLowerCase() !== repository) return line
            const [, prefix = '', , workflow = '', ref = '', rest = ''] = match
            const next = `${prefix}${commit}${withVersionComment(rest, version)}`
            changes.push({
                file,
                line: index + 1,
                what: workflow,
                from: ref,
                to: commit,
                ...(ref === commit && next !== line ? { comment: true } : {}),
            })
            return next
        })
        if (changes.length > 0) edited.push({ file, text: lines.join('\n'), changes })
    }
    return edited
}

/**
 * @typedef {{ kind: 'object', start: number, end: number, props: { key: string, keyStart: number, node: Node }[] }
 *   | { kind: 'array', start: number, end: number }
 *   | { kind: 'string', start: number, end: number, value: string }
 *   | { kind: 'other', start: number, end: number }} Node a JSON value and where its text sits
 */

/**
 * Where each value of a JSON text sits (the offsets of its first and one past its last character), so a value can be
 * replaced without printing the whole file again. The text has already been through `JSON.parse`, so it is valid.
 * @param {string} text
 * @returns {Node}
 */
function locate(text) {
    let i = 0
    const space = () => {
        while (i < text.length && /\s/.test(text.charAt(i))) i++
    }
    /** @returns {Node & { kind: 'string' }} */
    const string = () => {
        const start = i
        for (i++; text.charAt(i) !== '"'; i++) if (text.charAt(i) === '\\') i++
        i++
        return { kind: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) }
    }
    /** @returns {Node} */
    const value = () => {
        space()
        const start = i
        const first = text.charAt(i)
        if (first === '{') {
            /** @type {(Node & { kind: 'object' })['props']} */
            const props = []
            i++
            space()
            while (text.charAt(i) !== '}') {
                space()
                const key = string()
                space()
                i++ // the colon
                props.push({ key: key.value, keyStart: key.start, node: value() })
                space()
                if (text.charAt(i) === ',') i++
                space()
            }
            i++
            return { kind: 'object', start, end: i, props }
        }
        if (first === '[') {
            i++
            space()
            while (text.charAt(i) !== ']') {
                value()
                space()
                if (text.charAt(i) === ',') i++
                space()
            }
            i++
            return { kind: 'array', start, end: i }
        }
        if (first === '"') return string()
        while (i < text.length && !/[\s,\]}]/.test(text.charAt(i))) i++
        return { kind: 'other', start, end: i }
    }
    return value()
}

/**
 * The property of an object node named `key`; of several, the last, which is the one `JSON.parse` keeps, and so the one
 * Claude Code and `sssb doctor` read.
 * @param {(Node & { kind: 'object' })['props']} props
 * @param {string} key
 */
const lastProp = (props, key) => props.findLast((prop) => prop.key === key)

/**
 * The marketplaces `.claude/settings.json` declares from `repository`, their `ref` moved to `commit`: replaced where
 * there is one, added to the `source` where there is none (a marketplace that follows the default branch).
 * @param {SourceFile} settings
 * @param {string} repository `owner/name`, lowercased
 * @param {string} commit
 * @returns {{ edited: Edited | null, refusal: string | null }}
 */
function raiseMarketplacePins({ file, text }, repository, commit) {
    try {
        JSON.parse(text)
    } catch (error) {
        return {
            edited: null,
            refusal: `${file} is not JSON this command can read (${error instanceof Error ? error.message : error})`,
        }
    }
    const root = locate(text)
    const marketplaces = root.kind === 'object' ? lastProp(root.props, 'extraKnownMarketplaces') : null
    /** @type {{ start: number, end: number, insert: string }[]} */
    const edits = []
    /** @type {Change[]} */
    const changes = []
    if (marketplaces?.node.kind === 'object') {
        for (const { key: name, node: entry } of marketplaces.node.props) {
            const source = entry.kind === 'object' ? lastProp(entry.props, 'source')?.node : null
            if (source?.kind !== 'object') continue
            const valueOf = (/** @type {string} */ key) => {
                const node = lastProp(source.props, key)?.node
                return node?.kind === 'string' ? node.value : undefined
            }
            if (
                sourceRepository({ source: valueOf('source'), repo: valueOf('repo'), url: valueOf('url') }) !==
                repository
            )
                continue
            const what = `marketplace ${name}`
            const ref = lastProp(source.props, 'ref')
            if (ref === undefined) {
                const last = source.props.at(-1)
                const first = source.props[0]
                if (last === undefined || first === undefined) continue
                const lineStart = text.lastIndexOf('\n', first.keyStart) + 1
                const indent = text.slice(lineStart, first.keyStart)
                const multiline = text.slice(source.start, first.keyStart).includes('\n') && /^\s*$/.test(indent)
                edits.push({
                    start: last.node.end,
                    end: last.node.end,
                    insert: multiline
                        ? `,${text.includes('\r\n') ? '\r\n' : '\n'}${indent}"ref": ${JSON.stringify(commit)}`
                        : `, "ref": ${JSON.stringify(commit)}`,
                })
                changes.push({ file, what, from: null, to: commit })
            } else if (ref.node.kind !== 'string') {
                return { edited: null, refusal: `${file} (${what}): its \`ref\` is not a string, so it is not a pin` }
            } else {
                if (ref.node.value !== commit)
                    edits.push({ start: ref.node.start, end: ref.node.end, insert: JSON.stringify(commit) })
                changes.push({ file, what, from: ref.node.value, to: commit })
            }
        }
    }
    if (changes.length === 0)
        return {
            edited: null,
            refusal: `${file} declares no marketplace from ${repository}: there is no plugin pin to raise`,
        }
    let next = text
    for (const { start, end, insert } of edits.sort((a, b) => b.start - a.start))
        next = next.slice(0, start) + insert + next.slice(end)
    return { edited: { file, text: next, changes }, refusal: null }
}

/**
 * Every pin of `repository` in the workspace's files, raised to `commit`; or what stops it. Pure: it reads nothing and
 * writes nothing.
 * @param {{
 *   commit: string,
 *   version: string,
 *   repository: string,
 *   workflows: SourceFile[],
 *   settings: SourceFile | null,
 * }} input `version`: the installed kit's, which a workflow pin's comment may name; `settings`: null when the workspace
 *   has no `.claude/settings.json`
 * @returns {{ files: Edited[], refusals: string[], notes: string[] }} `files`: each file that holds a pin, `text` as it
 *   will be; nothing is to be written when `refusals` is not empty
 */
export function planPins({ commit, version, repository, workflows, settings }) {
    /** @type {string[]} */
    const refusals = []
    /** @type {string[]} */
    const notes = []
    const files = raiseWorkflowPins(workflows, repository, commit, version)
    if (files.length === 0)
        refusals.push(
            `no workflow under .github/workflows calls a reusable workflow of ${repository}, so there is no workflow pin to raise`,
        )
    if (settings === null)
        notes.push(
            `no ${SETTINGS}: no plugin marketplace pin to raise (a workspace whose people do not use Claude Code has none)`,
        )
    else {
        const { edited, refusal } = raiseMarketplacePins(settings, repository, commit)
        if (refusal !== null) refusals.push(refusal)
        if (edited !== null) files.push(edited)
    }
    return { files, refusals, notes }
}

/**
 * The app whose kit's stamp is read, as `sssb guide` chooses it: `--app <dir>`; else the working directory when it
 * resolves `@sssb/kit`; else, at a workspace root that takes no framework (a generated workspace's), the first of the
 * workspace's apps that resolves one (`guide` and `doctor` take its first app, resolving or not).
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function pinApp(args, cwd = process.cwd()) {
    if (args.includes('--app')) return takeAppDir(args, cwd)
    const here = path.resolve(cwd)
    const resolves = (/** @type {string} */ dir) => {
        try {
            kitDirOf(dir)
            return true
        } catch {
            return false
        }
    }
    const isRoot = existsSync(path.join(here, 'pnpm-workspace.yaml')) && existsSync(path.join(here, 'package.json'))
    if (isRoot && !resolves(here)) {
        const app = workspaceApps(here)
            .map((dir) => path.resolve(here, dir))
            .find(resolves)
        if (app === undefined) {
            throw new UsageError(
                `sssb pin: ${here} is a workspace root that takes no @sssb/kit, and none of its apps (\`sssb.apps\` in its ` +
                    'package.json, or apps/<name>) resolves one: pass --app <dir>',
            )
        }
        return app
    }
    // Anything else: the app is the working directory, and kitDirOf's refusal says to name one with --app.
    return takeAppDir(args, cwd)
}

/** @param {string} file */
const readIfThere = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)

/**
 * The workspace root's `.github/workflows/*.{yml,yaml}`, sorted, with their text (as doctor reads them).
 * @param {string} root
 * @returns {SourceFile[]}
 */
function workflowFiles(root) {
    const dir = path.join(root, '.github', 'workflows')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
        .map((name) => ({
            file: `.github/workflows/${name}`,
            text: /** @type {string} */ (readIfThere(path.join(dir, name))),
        }))
}

/** @param {string[]} args */
export async function run(args) {
    const appDir = realpathSync(pinApp(args))
    if (args.length > 0) throw new UsageError(`sssb pin: unknown argument ${args[0]} (usage: pin [--app <dir>])`)
    const root = realpathSync(workspaceRootOf(appDir))
    const kitDir = kitDirOf(appDir)
    const version = kitVersionOf(appDir)
    const kit = `@sssb/kit ${version}`
    const stamp = kitReleaseStampOf(appDir)

    if (isInRepoKit(kitDir, root)) {
        throw new UsageError(
            `sssb pin: ${kit} here is this workspace's own source, which carries no release stamp (dist/release.json), so ` +
                'there is no release commit to pin SSSB to. Nothing was changed',
        )
    }
    const commit = stampedCommit(stamp)
    if (commit === null) {
        throw new UsageError(
            `sssb pin: ${kit} ` +
                (stamp === null
                    ? 'carries no release stamp (dist/release.json): it was packed by hand, or before ADR-0014 P13 stamped one'
                    : 'has a release stamp (dist/release.json) that names no commit') +
                ', so there is no release commit to pin SSSB to. Nothing was changed',
        )
    }
    const repository = githubRepositoryOf(readJson(path.join(kitDir, 'package.json')).repository)
    if (repository === null) {
        throw new UsageError(
            `sssb pin: ${kit}'s package.json names no GitHub repository, so this cannot tell which pins are SSSB's. Nothing was changed`,
        )
    }

    const settingsText = readIfThere(path.join(root, ...SETTINGS.split('/')))
    const workflows = workflowFiles(root)
    const plan = planPins({
        commit,
        version,
        repository,
        workflows,
        settings: settingsText === null ? null : { file: SETTINGS, text: settingsText },
    })
    if (plan.refusals.length > 0) {
        throw new UsageError(
            [
                `sssb pin: not raising any pin, because the workspace's files are not what this command edits (${kit}, release commit ${commit}):`,
                ...plan.refusals.map((refusal) => `  ${refusal}`),
                'Nothing was changed. Edit the pins by hand, as the release notes say, or put the files back in the shape ' +
                    '`sssb doctor` reads, then run this again',
            ].join('\n'),
        )
    }

    console.log(`sssb pin: ${kit}, release commit ${commit}`)
    const before = new Map(
        [...workflows, ...(settingsText === null ? [] : [{ file: SETTINGS, text: settingsText }])].map((f) => [
            f.file,
            f.text,
        ]),
    )
    let moved = 0
    /** @type {string[]} */
    const marketplaces = []
    for (const { file, text, changes } of plan.files) {
        const changed = text !== before.get(file)
        for (const change of changes) {
            const where = `${file}${change.line === undefined ? '' : `:${change.line}`} (${change.what})`
            const was = change.from === null ? 'no ref' : change.from
            if (change.comment) {
                console.log(`  ${where}: already ${change.to}; the version in its comment is now ${version}`)
                moved++
            } else if (change.from === change.to) console.log(`  ${where}: already ${change.to}`)
            else {
                console.log(`  ${where}: ${was} -> ${change.to}`)
                moved++
            }
            if (change.what.startsWith('marketplace ')) marketplaces.push(change.what.slice('marketplace '.length))
        }
        if (changed) writeFileSync(path.join(root, ...file.split('/')), text)
    }
    for (const note of plan.notes) console.log(`  ${note}`)
    if (moved === 0) console.log('Every pin was already the release commit: nothing changed.')
    else {
        console.log(`Raised ${moved} pin(s) to ${commit}. Review the diff, then commit it with the package versions.`)
        if (marketplaces.length > 0) {
            console.log(
                'Then each person updates their installed plugin and restarts Claude Code: ' +
                    `\`claude plugin marketplace update ${marketplaces[0]}\`, then \`claude plugin update <plugin>@${marketplaces[0]} --scope project\``,
            )
        }
    }
    return 0
}
