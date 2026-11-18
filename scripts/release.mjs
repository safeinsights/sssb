#!/usr/bin/env node
// SSSB's release logic (ADR-0014 part 10). `.github/workflows/release.yml` and CI's `release-plan` job call
// it; nothing else should. Every command reads Changesets' own config and planner, so the plan judged here is
// the plan `changeset version` applies.
//
//   check                         Every PR. Fails on a `major` changeset for a package on 0.x, and on any plan
//                                 that reaches 1.0.0, because npm versions cannot be withdrawn. It judges the
//                                 plan as it will be once `private` comes off (P14): today Changesets plans
//                                 nothing for a private package, and a check of that plan could never fail. It
//                                 also fails on what would stall a release later: a changeset naming a package
//                                 outside the fixed group, a group member outside packages/ or without
//                                 repository.url, a group that is part private.
//   prepare [--allow-dirty] [--notes <file>]
//                                 The `plan` job. Plans, guards, assembles the release notes from the pending changesets
//                                 (scripts/release-notes.mjs; written to <file>, which must be outside the tree), then runs `changeset version` in the working
//                                 tree and commits nothing. stdout is one JSON object, `{"release":false,
//                                 "reason":…}` or `{"release":true,"version":…,"packages":[…]}`.
//   verify-release <version>      The `push` job, which holds the release app's key. From HEAD alone, works out
//                                 the release the pending changesets imply and fails unless the staged patch is
//                                 exactly that; prints `verified <version>`. Needs no installed dependencies.
//   publishable <version>         The tag's pack job. The packages to publish, as JSON, and `[]` while every
//                                 package is private. Fails if a non-private package is outside the fixed group
//                                 or at another version.
//   preflight <version> <sha> <tarball>…
//                                 The publish job, before its first publish. Prints the tarballs still to publish
//                                 after checking each one's own manifest. A version already on npm from this
//                                 commit is skipped, so a re-run resumes a release that stopped part-way; one from
//                                 another commit, or a newer `latest`, fails before anything is published. Needs
//                                 no installed dependencies.
//   wait-for-checks <sha>         Both halves of a release. Waits for the `checks` workflow's push run on that
//                                 commit of `main` to pass, and fails on any other conclusion or after an hour;
//                                 prints `passed <sha>`. Reads GITHUB_REPOSITORY and GH_TOKEN. Needs no installed
//                                 dependencies.
//
// Failures exit 1 with the reason on stderr. Children write to stderr too, so stdout carries only the result.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Node's global fetch, the default; tests pass a stub registry instead. */
const { fetch } = globalThis

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY_URL = /^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/
const REGISTRY = 'https://registry.npmjs.org'
const USAGE = [
    'usage: release.mjs check',
    '       release.mjs prepare [--allow-dirty] [--notes <file>]',
    '       release.mjs publishable <version>',
    '       release.mjs preflight <version> <sha> <tarball>...',
    '       release.mjs verify-release <version>',
    '       release.mjs wait-for-checks <sha>',
].join('\n')

const major = (version) => Number(version.split('.')[0])

/** A manifest's `private`, which must be absent or a boolean: `"private": "true"` is neither, and fails. */
function isPrivate(manifest, where) {
    if (manifest.private === undefined) return false
    if (typeof manifest.private !== 'boolean') throw new Error(`${where}: "private" must be true or false`)
    return manifest.private
}

/** > 0 when plain version a is newer than b. */
function compareVersions(a, b) {
    const x = a.split('.').map(Number)
    const y = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
    return 0
}

/**
 * The workspace as Changesets reads it. Loaded lazily, so `preflight` and `verify-release`, which run in the
 * jobs that install nothing, import no dependency at all.
 */
async function loadWorkspace(root) {
    const [{ getPackages }, { readConfig }, { readChangesets }, { assembleReleasePlan }] = await Promise.all([
        import('@manypkg/get-packages'),
        import('@changesets/config'),
        import('@changesets/read'),
        import('@changesets/assemble-release-plan'),
    ])
    const packages = await getPackages(root)
    const parsed = await readConfig(root, packages)
    if (parsed.errors) throw new Error(`.changeset/config.json: ${parsed.errors.join('; ')}`)
    const { config } = parsed
    // SSSB's packages are one fixed group (one version for the set); the glob in the config covers every
    // `@sssb/*` workspace package, so a new one joins without an edit.
    if (config.fixed.length !== 1) {
        throw new Error(`.changeset/config.json must have exactly one fixed group, found ${config.fixed.length}`)
    }
    const fixed = new Set(config.fixed[0])
    const outside = packages.packages
        .map((p) => p.packageJson.name)
        .filter((name) => name.startsWith('@sssb/') && !fixed.has(name))
    if (outside.length > 0) throw new Error(`outside the fixed group: ${outside.join(', ')}`)
    // Prereleases are GitHub-release tarballs (ADR-0014 P7), never Changesets' pre mode, whose plans this
    // script does not read.
    if (existsSync(path.join(root, '.changeset', 'pre.json'))) {
        throw new Error('.changeset/pre.json exists; SSSB does not use Changesets pre mode')
    }
    const changesets = await readChangesets(root)
    const plan = (cfg) =>
        assembleReleasePlan(changesets, packages, cfg, undefined).releases.filter((r) => r.type !== 'none')
    return { packages: packages.packages, config, fixed, changesets, plan }
}

/**
 * The PR check. Returns the problems (empty when the changesets are acceptable) and the plan it judged: the
 * one Changesets will apply once `private` comes off, which is the only plan that can ever reach npm.
 */
export async function check(root) {
    const ws = await loadWorkspace(root)
    const versions = new Map(ws.packages.map((p) => [p.packageJson.name, p.packageJson.version]))
    const problems = []
    const group = ws.packages.filter((p) => ws.fixed.has(p.packageJson.name))
    for (const p of group) {
        // npm requires `repository.url` to match the GitHub repository that publishes (docs.npmjs.com/
        // trusted-publishers), and a publish refused for it comes after the release's tag exists; so it is
        // required from the first PR.
        if (!REPOSITORY_URL.test(p.packageJson.repository?.url ?? '')) {
            problems.push(
                `${p.relativeDir}/package.json needs "repository": { "url": "git+https://github.com/<owner>/<repo>.git" }`,
            )
        }
        // The release job's check (verifyRelease) reads only packages/*, the one place SSSB's packages live.
        if (!MANIFEST.test(`${p.relativeDir}/package.json`)) {
            problems.push(`${p.packageJson.name} is in ${p.relativeDir}; a released package lives in packages/<name>`)
        }
    }
    // Part private, part public, and Changesets would version some of the group and leave the changesets that
    // name the rest pending forever, which stops every later release.
    const privacy = new Set(group.map((p) => isPrivate(p.packageJson, `${p.relativeDir}/package.json`)))
    if (privacy.size > 1) problems.push('the fixed group must be all private or all public')
    for (const changeset of ws.changesets) {
        for (const release of changeset.releases) {
            // A changeset that names a package outside the group is never consumed while that package is
            // private, and a mixed one makes Changesets refuse the whole plan: either would stop every release.
            if (!ws.fixed.has(release.name)) {
                problems.push(
                    `.changeset/${changeset.id}.md names ${release.name}, which is not released; name only ${[...ws.fixed].join(', ')}`,
                )
            }
            const current = versions.get(release.name)
            if (release.type === 'major' && current !== undefined && major(current) === 0) {
                problems.push(
                    `.changeset/${changeset.id}.md files a major for ${release.name}, which is on ${current}. ` +
                        'On 0.x a breaking change is a minor (ADR-0014 part 10); a major would release 1.0.0.',
                )
            }
        }
    }
    // The release notes are written from these files (scripts/release-notes.mjs), so a body that cannot be read
    // would fail the release after its plan was already accepted. Loaded here, not at the top: release.yml's `push`
    // and `publish` jobs run a lone copy of this file with no sibling modules.
    const { lintChangesets } = await import('./release-notes.mjs')
    problems.push(...lintChangesets(root, { judgePackages: false }))
    // Only the fixed group is ever published; the apps that depend on it would be planned too, and are noise.
    const asPublished = ws
        .plan({ ...ws.config, privatePackages: { version: true, tag: false } })
        .filter((r) => ws.fixed.has(r.name))
    for (const release of asPublished) {
        if (!PLAIN_VERSION.test(release.newVersion) || major(release.newVersion) >= 1) {
            problems.push(
                `the release plan takes ${release.name} from ${release.oldVersion} to ${release.newVersion}; ` +
                    'nothing reaches 1.0.0 from an ordinary PR',
            )
        }
    }
    return { problems, plan: asPublished, changesets: ws.changesets.length }
}

/** npm's `latest` for a package, or null when the registry has never heard of it. */
async function npmLatest(name, fetchImpl) {
    const res = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`${name}: registry answered ${res.status}`)
    const latest = (await res.json())['dist-tags']?.latest
    if (typeof latest !== 'string') throw new Error(`${name}: the registry reports no latest`)
    return latest
}

function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 2] })
}

/** The newest plain `vX.Y.Z` tag in the repository, or null. */
function latestStableTag(root) {
    const versions = git(root, ['tag', '--list', 'v*'])
        .split('\n')
        .map((t) => t.trim().slice(1))
        .filter((v) => PLAIN_VERSION.test(v))
    return versions.sort(compareVersions).at(-1) ?? null
}

/**
 * The `plan` job's preparation. Commits nothing: the `push` job applies what this leaves, after
 * `verifyRelease` has checked it.
 * @param {string} root
 * @param {{ allowDirty?: boolean, fetchImpl?: typeof fetch, notesFile?: string }} [options] `notesFile`: where to
 *   write the release notes, which must be outside `root`
 */
export async function prepare(root, { allowDirty = false, fetchImpl = fetch, notesFile } = {}) {
    if (!allowDirty) {
        const dirty = git(root, ['status', '--porcelain']).trim()
        if (dirty) throw new Error(`the tree has uncommitted changes, which a release commit would carry:\n${dirty}`)
    }
    const judged = await check(root)
    if (judged.problems.length > 0) throw new Error(judged.problems.join('\n'))
    if (judged.changesets === 0) return { release: false, reason: 'no changesets are pending' }

    const ws = await loadWorkspace(root)
    const releases = ws.plan(ws.config)
    if (releases.length === 0) {
        // Until P14 every package is private and Changesets versions none of them, so this is the answer on
        // every push to main. The changesets stay pending, and nothing is consumed or tagged.
        return {
            release: false,
            reason: 'the pending changesets release nothing: they name only private packages, or are empty',
        }
    }
    const strays = releases.filter((r) => !ws.fixed.has(r.name)).map((r) => r.name)
    if (strays.length > 0) {
        throw new Error(`only the fixed group is released, and the plan also releases ${strays.join(', ')}`)
    }
    const planned = new Set(releases.map((r) => r.newVersion))
    const [version] = planned
    if (planned.size !== 1 || !PLAIN_VERSION.test(version) || major(version) !== 0) {
        throw new Error(
            `the plan must release one 0.x version, got ${releases.map((r) => `${r.name}@${r.newVersion}`).join(', ')}`,
        )
    }
    const repo = process.env.GITHUB_REPOSITORY
    if (repo) {
        const expected = `git+https://github.com/${repo}.git`
        const wrongRepo = ws.packages
            .filter((p) => releases.some((r) => r.name === p.packageJson.name))
            .filter((p) => p.packageJson.repository?.url !== expected)
            .map((p) => p.packageJson.name)
        if (wrongRepo.length > 0) {
            throw new Error(`npm's provenance needs repository.url ${expected} in ${wrongRepo.join(', ')}`)
        }
    }
    const floors = [['the latest stable tag', latestStableTag(root)]]
    for (const r of releases) floors.push([`npm's latest ${r.name}`, await npmLatest(r.name, fetchImpl)])
    for (const [what, floor] of floors) {
        if (floor !== null && PLAIN_VERSION.test(floor) && compareVersions(version, floor) <= 0) {
            throw new Error(
                `the changesets plan ${version}, which is not newer than ${what} (${floor}); a release never goes backwards`,
            )
        }
    }

    // THE RELEASE NOTES, from the changesets as they are NOW: `changeset version` deletes them. Assembled (and so
    // judged) even when nobody asks for the file, so a malformed changeset stops the release before anything is
    // changed. The file goes outside the tree, which the release commit would otherwise carry, and verifyRelease
    // would refuse.
    const { releaseNotes } = await import('./release-notes.mjs')
    const { markdown } = releaseNotes(root, { version })
    if (notesFile !== undefined) {
        const rel = path.relative(root, path.resolve(notesFile))
        if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
            throw new Error(`the release notes go outside the working tree, not ${notesFile}`)
        }
        writeFileSync(notesFile, markdown)
    }

    // This repository's own CLI, resolved here rather than at load (the publish job has no node_modules), so a
    // fixture workspace without node_modules can be versioned too.
    // `format` makes Changesets run `pnpm exec prettier`, and pnpm 11 first re-installs, scripts and all, when a
    // workspace version has changed (`verify-deps-before-run`), which the bump has just done. Turned off here.
    const changeset = fileURLToPath(import.meta.resolve('@changesets/cli/bin.js'))
    execFileSync(process.execPath, [changeset, 'version'], {
        cwd: root,
        stdio: ['ignore', 2, 2],
        env: {
            ...process.env,
            pnpm_config_verify_deps_before_run: 'false',
            npm_config_verify_deps_before_run: 'false',
        },
    })

    const after = await loadWorkspace(root)
    const wrong = after.packages
        .filter((p) => releases.some((r) => r.name === p.packageJson.name) && p.packageJson.version !== version)
        .map((p) => `${p.packageJson.name} is at ${p.packageJson.version}`)
    if (after.changesets.length > 0) wrong.push(`changesets remain: ${after.changesets.map((c) => c.id).join(', ')}`)
    if (wrong.length > 0) throw new Error(`after \`changeset version\` to ${version}: ${wrong.join('; ')}`)
    return { release: true, version, packages: releases.map((r) => r.name).sort() }
}

/**
 * The packages a tag publishes: every non-private workspace package, each of which must be in the fixed group
 * and at the tag's version. Empty while every package is private, which makes the publish a no-op until P14.
 */
export async function publishable(root, version) {
    if (!PLAIN_VERSION.test(version)) throw new Error(`not a release version: '${version}'`)
    const ws = await loadWorkspace(root)
    const open = ws.packages.filter((p) => !isPrivate(p.packageJson, `${p.relativeDir}/package.json`))
    const wrong = open
        .filter((p) => !ws.fixed.has(p.packageJson.name) || p.packageJson.version !== version)
        .map((p) => `${p.packageJson.name}@${p.packageJson.version} (${p.relativeDir})`)
    if (wrong.length > 0) {
        throw new Error(
            `v${version} publishes only the fixed group at ${version}, and these are not: ${wrong.join(', ')}`,
        )
    }
    return open
        .map((p) => ({ name: p.packageJson.name, dir: p.relativeDir }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The commit a published version was built from, read from its npm SLSA provenance, or null when that
 * version is not on npm. Any other answer throws: a caller deciding whether to publish must not read
 * "unknown" as "absent". (After CanopyCMS's scripts/npm-attested-commit.mjs.)
 */
export async function attestedCommit(name, version, fetchImpl = fetch) {
    const id = `${encodeURIComponent(name)}@${encodeURIComponent(version)}`
    const res = await fetchImpl(`${REGISTRY}/-/npm/v1/attestations/${id}`)
    if (res.status === 404) {
        // The attestations endpoint also answers 404 for a version published without provenance.
        const existing = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`)
        if (existing.status === 404) return null
        if (!existing.ok) throw new Error(`${name}@${version}: registry answered ${existing.status}`)
        throw new Error(`${name}@${version} is on npm without provenance, or not yet attested`)
    }
    if (!res.ok) throw new Error(`${name}@${version}: registry answered ${res.status}`)
    const slsa = (await res.json()).attestations?.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1')
    if (!slsa) throw new Error(`${name}@${version} is on npm without SLSA provenance`)
    const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
    const sha = statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error(`${name}@${version}: its provenance names no commit`)
    return sha
}

/**
 * The fixed group's patterns, read from the config's JSON with no dependency (the publish job installs none)
 * and matched as Changesets matches them for a scope glob: `*` is any run of characters but `/`.
 */
function fixedGroupMatcher(root, rev) {
    const config = JSON.parse(
        rev
            ? git(root, ['show', `${rev}:.changeset/config.json`])
            : readFileSync(path.join(root, '.changeset', 'config.json'), 'utf8'),
    )
    if (!Array.isArray(config.fixed) || config.fixed.length !== 1) {
        throw new Error('.changeset/config.json must have exactly one fixed group')
    }
    const patterns = config.fixed[0].map(
        (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`),
    )
    return (name) => patterns.some((re) => re.test(name))
}

/**
 * The tarballs still to publish for this release, as `[{name, file}]`. Throws, before any publish, on anything
 * that must not go out: a tarball outside the fixed group, at another version, or private; a version already
 * on npm from another commit; or a `latest` newer than this release, which a late re-run must not move back.
 */
export async function preflight(root, version, sha, files, fetchImpl = fetch) {
    if (!PLAIN_VERSION.test(version)) throw new Error(`not a release version: '${version}'`)
    if (!SHA.test(sha)) throw new Error(`not a commit: '${sha}'`)
    if (files.length === 0) throw new Error('no tarballs to publish')
    const inFixedGroup = fixedGroupMatcher(root)
    const todo = []
    const problems = []
    const seen = new Set()
    const tar = (args) => execFileSync('tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 2] })
    for (const file of files) {
        // npm reads the manifest from whatever the first directory is called, so a tarball laid out any other way
        // than `pnpm pack`'s could show this check one manifest and npm another.
        // Every entry is a file or a directory at a normalized path under `package/`: no `..`, `.` or empty
        // segment that an extractor could resolve onto another entry, and no link.
        const entries = tar(['-tzf', file]).split('\n').filter(Boolean)
        const kinds = tar(['-tvzf', file])
            .split('\n')
            .filter(Boolean)
            .map((line) => line[0])
        const strays = entries.filter((e) => !e.startsWith('package/') || path.posix.normalize(e) !== e)
        if (
            strays.length > 0 ||
            kinds.length !== entries.length ||
            kinds.some((k) => k !== '-' && k !== 'd') ||
            entries.filter((e) => e === 'package/package.json').length !== 1
        ) {
            problems.push(`${file} is not laid out as one package/ of plain files with one package/package.json`)
            continue
        }
        const manifest = JSON.parse(tar(['-xzOf', file, 'package/package.json']))
        const { name } = manifest
        if (typeof name !== 'string' || !inFixedGroup(name)) {
            problems.push(`${file} holds ${name}, which is not in the fixed group`)
            continue
        }
        if (seen.has(name)) problems.push(`${name} is packed twice`)
        seen.add(name)
        if (manifest.version !== version) problems.push(`${file} holds ${name}@${manifest.version}, not ${version}`)
        if (isPrivate(manifest, file)) problems.push(`${file} holds ${name}, which is private`)
        const attested = await attestedCommit(name, version, fetchImpl)
        if (attested === sha) continue
        if (attested !== null) {
            problems.push(`${name}@${version} is on npm from ${attested}, not this release (${sha})`)
            continue
        }
        const latest = await npmLatest(name, fetchImpl)
        if (latest !== null && PLAIN_VERSION.test(latest) && compareVersions(latest, version) > 0) {
            problems.push(`${name}: npm's latest is ${latest}, newer than ${version}`)
            continue
        }
        todo.push({ name, file })
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
    return todo
}

const CHANGESET_FILE = /^\.changeset\/[^/]+\.md$/
const MANIFEST = /^packages\/[^/]+\/package\.json$/
const CHANGELOG = /^packages\/[^/]+\/CHANGELOG\.md$/

const BUMPS = ['patch', 'minor', 'major']

/** Whether Changesets (@changesets/read 1.0.1) reads this `.changeset/` file as a changeset. */
export function isChangesetName(name) {
    return (
        name.endsWith('.md') &&
        !name.startsWith('.') &&
        !/^readme\.md$/i.test(name) &&
        !['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name)
    )
}

/**
 * The releases a changeset's frontmatter names, read without a YAML parser (the `push` job installs none): one
 * `"name": type` per line, and anything else fails rather than being guessed at.
 */
function changesetReleases(text, where) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n?---/.exec(text)
    if (!frontmatter) throw new Error(`${where}: no frontmatter`)
    return frontmatter[1]
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
            const m = /^\s*(["']?)([^"'\s:][^"']*?)\1\s*:\s*(major|minor|patch|none)\s*$/.exec(line)
            if (!m) throw new Error(`${where}: cannot read "${line}"`)
            return { name: m[2], type: m[3] }
        })
}

/**
 * The `push` job's check of the staged release, before it mints the release app's token. The release was
 * prepared in another job, by dependency code, so nothing it says is taken on trust. From HEAD alone this
 * works out what the release must be: every pending changeset consumed, every public fixed-group manifest under
 * packages/ (where `check` keeps the group) moved
 * to the one version those changesets imply. The index may then differ from HEAD by exactly that: the
 * changesets deleted, each of those manifests changed in its version line and nowhere else, and plain-file
 * changelogs beside them. The version must also be newer than every `vX.Y.Z` tag. Needs no installed dependency.
 */
export function verifyRelease(root, version) {
    const problems = []
    if (!PLAIN_VERSION.test(version) || major(version) !== 0) problems.push(`not a 0.x release version: '${version}'`)
    if (git(root, ['diff', '--name-only']).trim() || git(root, ['ls-files', '--others', '--exclude-standard']).trim()) {
        problems.push('the tree holds changes that are not staged')
    }
    const inFixedGroup = fixedGroupMatcher(root, 'HEAD')
    const atHead = (file) => git(root, ['show', `HEAD:${file}`])
    const tracked = git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)

    // What HEAD says the release is.
    const released = new Map()
    for (const file of tracked.filter((f) => MANIFEST.test(f))) {
        const manifest = JSON.parse(atHead(file))
        if (inFixedGroup(manifest.name) && !isPrivate(manifest, file)) released.set(file, manifest.version)
    }
    const pending = tracked.filter((f) => CHANGESET_FILE.test(f) && isChangesetName(path.basename(f)))
    let bump = -1
    for (const file of pending) {
        for (const r of changesetReleases(atHead(file), file)) {
            if (!inFixedGroup(r.name)) problems.push(`${file} names ${r.name}, which is not in the fixed group`)
            else bump = Math.max(bump, BUMPS.indexOf(r.type))
        }
    }
    const current = [...new Set(released.values())]
    if (released.size === 0) problems.push('no fixed-group package is public, so there is nothing to release')
    else if (current.length !== 1) problems.push(`the fixed group is at several versions: ${current.join(', ')}`)
    else if (bump < 0) problems.push('the pending changesets release nothing')
    else {
        const [ma, mi, pa] = current[0].split('.').map(Number)
        const expected = [`${ma}.${mi}.${pa + 1}`, `${ma}.${mi + 1}.0`, `${ma + 1}.0.0`][bump]
        if (expected !== version) problems.push(`the pending changesets release ${expected}, not ${version}`)
    }

    // What the index holds. `--raw` gives old mode, new mode, status and path, so a symlink, an executable or a
    // gitlink cannot pass as a plain file.
    const deleted = new Set()
    const bumped = new Set()
    const plain = (mode) => mode === '100644'
    const raw = git(root, ['diff', '--cached', '--raw', '--no-renames', '-z', 'HEAD']).split('\0').filter(Boolean)
    for (let i = 0; i < raw.length; i += 2) {
        const [oldMode, newMode, , , status] = raw[i].slice(1).split(' ')
        const file = raw[i + 1]
        const dir = path.posix.dirname(file)
        if (status === 'D' && pending.includes(file)) {
            deleted.add(file)
            continue
        }
        if (
            CHANGELOG.test(file) &&
            released.has(`${dir}/package.json`) &&
            plain(newMode) &&
            (status === 'A' || (status === 'M' && plain(oldMode)))
        ) {
            continue
        }
        if (status === 'M' && released.has(file) && plain(oldMode) && plain(newMode)) {
            // Byte for byte but the version line, so a duplicate key or a reordering cannot hide in "equal JSON".
            const before = atHead(file).split('\n')
            const staged = git(root, ['show', `:${file}`])
            const after = staged.split('\n')
            const changed = before.map((line, n) => n).filter((n) => before[n] !== after[n])
            const from = `"version": "${released.get(file)}"`
            const line = changed[0]
            if (
                before.length !== after.length ||
                changed.length !== 1 ||
                !before[line].includes(from) ||
                before[line].replace(from, `"version": "${version}"`) !== after[line] ||
                JSON.parse(staged).version !== version
            ) {
                problems.push(`${file} must change only its version, to ${version}`)
            } else bumped.add(file)
            continue
        }
        problems.push(`the release may not change ${file} (${status} ${oldMode} → ${newMode})`)
    }
    for (const file of pending) if (!deleted.has(file)) problems.push(`${file} is not consumed`)
    for (const file of released.keys()) if (!bumped.has(file)) problems.push(`${file} is not moved to ${version}`)
    const tag = latestStableTag(root)
    if (tag !== null && compareVersions(version, tag) <= 0) problems.push(`${version} is not newer than v${tag}`)
    if (problems.length > 0) throw new Error(problems.join('\n'))
}

/**
 * THE CI GATE. `checks` and release.yml start on the same push and run side by side, and a merge commit can be
 * red where both of its parents were green, so a release waits for `checks` on the exact commit: the merge
 * commit before versioning, and the release commit before publishing (ADR-0014 part 10's two-consumer rule).
 * Status and conclusion come from one read of the newest run. FAIL-CLOSED: any read that is not exactly
 * `completed success` (an error, an empty list, a malformed answer) keeps polling until the deadline throws.
 * Only a run that completed with another conclusion throws early.
 */
export async function waitForChecks({
    repo,
    sha,
    token,
    timeoutMs = 60 * 60 * 1000,
    intervalMs = 20 * 1000,
    fetchImpl = fetch,
    sleep = (ms) => delay(ms),
    now = Date.now,
}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`not a repository: '${repo}'`)
    if (!SHA.test(sha ?? '')) throw new Error(`not a commit: '${sha}'`)
    if (!token) throw new Error('GH_TOKEN is not set')
    const url = `https://api.github.com/repos/${repo}/actions/workflows/checks.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=1`
    const deadline = now() + timeoutMs
    let last
    for (;;) {
        try {
            const res = await fetchImpl(url, {
                headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
            })
            const run = res.ok ? (await res.json()).workflow_runs?.[0] : undefined
            last = res.ok ? `${run?.status ?? 'no run'} ${run?.conclusion ?? ''}`.trim() : `HTTP ${res.status}`
            if (run?.status === 'completed') {
                if (run.conclusion === 'success') return
                throw Object.assign(new Error(`checks concluded '${run.conclusion}' on ${sha}; refusing to release`), {
                    final: true,
                })
            }
        } catch (err) {
            if (err?.final) throw err
            last = err instanceof Error ? err.message : String(err)
        }
        if (now() >= deadline)
            throw new Error(`timed out waiting for checks on ${sha} (last: ${last}); refusing to release`)
        await sleep(intervalMs)
    }
}

async function main(argv) {
    const [command, ...rest] = argv
    const root = process.cwd()
    if (command === 'check' && rest.length === 0) {
        const { problems, plan, changesets } = await check(root)
        const lines = plan.map((r) => `  ${r.name}: ${r.oldVersion} -> ${r.newVersion} (${r.type})`)
        console.error(
            `${changesets} changeset(s) pending; once published they would release:\n${lines.join('\n') || '  nothing'}`,
        )
        if (problems.length > 0) throw new Error(problems.join('\n'))
        return
    }
    if (command === 'prepare') {
        const options = {}
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '--allow-dirty') options.allowDirty = true
            else if (rest[i] === '--notes' && rest[i + 1] !== undefined) options.notesFile = rest[++i]
            else throw new Error(USAGE)
        }
        console.log(JSON.stringify(await prepare(root, options)))
        return
    }
    if (command === 'publishable' && rest.length === 1) {
        console.log(JSON.stringify(await publishable(root, rest[0])))
        return
    }
    if (command === 'preflight' && rest.length >= 3) {
        const [version, sha, ...files] = rest
        console.log(JSON.stringify(await preflight(root, version, sha, files)))
        return
    }
    if (command === 'verify-release' && rest.length === 1) {
        verifyRelease(root, rest[0])
        // The workflow requires this line, so a run that somehow skipped the check cannot pass for one.
        console.log(`verified ${rest[0]}`)
        return
    }
    if (command === 'wait-for-checks' && rest.length === 1) {
        const { GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env
        await waitForChecks({ repo, sha: rest[0], token })
        // As above: the workflow requires this line.
        console.log(`passed ${rest[0]}`)
        return
    }
    throw new Error(USAGE)
}

/** Whether Node ran this file, by real path: run through a symlink, a plain comparison would skip `main`, exit 0. */
function isMain() {
    try {
        return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))
    } catch {
        return false
    }
}

if (isMain()) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
    })
}
