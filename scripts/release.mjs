#!/usr/bin/env node
// SSSB's release logic (ADR-0014 part 10). `.github/workflows/release.yml` and CI's `release-plan` and
// `release-dry-run` jobs run it; pack and consume imports `candidateNotes`, and the tests import it. Every command reads Changesets' own config and planner, so the plan judged here is
// the plan `changeset version` applies.
//
//   check                         Every PR. Fails on a `major` changeset for a package on 0.x, and on any plan
//                                 that reaches 1.0.0, because npm versions cannot be withdrawn. It also fails on what
//                                 would stall a release later: a changeset naming a package outside the fixed group,
//                                 a group member outside packages/ or without repository.url, a group that is part
//                                 private, a changeset whose body is not a readable release-note entry
//                                 (scripts/release-notes.mjs), and a private group outside pre mode `rc` or a public
//                                 one inside it. While the group was private (until P14) every release was a release
//                                 candidate, `0.x.y-rc.N`, cut by a merge to main and shipped as a GitHub prerelease
//                                 (ADR-0014 P7); .changeset/pre.json and a config that versions private packages
//                                 made Changesets plan one. From P14 the group is public and out of pre mode, and a
//                                 release is a plain `0.x.y` on npm, carrying the candidates' `.changeset/pre/` files
//                                 the first time.
//   prepare [--allow-dirty]       The `plan` job. Plans, guards, writes the release notes (assembled from the pending
//                                 changesets by scripts/release-notes.mjs) to docs/releases/v<version>.md, then runs
//                                 `changeset version` in the working tree and commits nothing. stdout is one JSON
//                                 object, `{"release":false,"reason":…}` or `{"release":true,"version":…,
//                                 "packages":[…],"notes":"docs/releases/v<version>.md"}`.
//   verify-release <version>      The `push` job, which holds the release app's key. From HEAD alone, works out
//                                 the release the pending changesets imply (a candidate's `-rc.N` as Changesets 3
//                                 numbers it) and fails unless the staged patch is exactly that, notes file included,
//                                 each consumed changeset deleted (out of pre mode, the `.changeset/pre/` ones too)
//                                 or, in pre mode, moved unchanged to `.changeset/pre/`; prints `verified <version>`.
//                                 Needs no installed dependencies.
//   publishable <version>         The tag's pack job. The packages to publish, as JSON (`[]` were every package
//                                 private). Fails if a non-private package is outside the fixed group or at another
//                                 version.
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
//   checks-run <sha>              A candidate's tag. The same gate, then `run <id>`: the run whose artifact holds the
//                                 tarballs pack-and-consume packed and tested on that commit.
//   candidate <version> <tarball>…
//                                 A candidate's tag, before anything is attested or attached. Checks the tarballs are
//                                 exactly the commit's fixed group at the candidate's version, one each, laid out as
//                                 `pnpm pack` lays them out, and prints each one's name, file, size, sha256 and sha512
//                                 as JSON. Needs no installed dependencies.
//   candidate-notes <version> <owner/repo> <sha> <assets.json>
//                                 The GitHub prerelease's notes: the release commit's docs/releases/v<version>.md, then
//                                 how to install each tarball by URL, its sha512, and how to verify its attestation.
//
// Failures exit 1 with the reason on stderr. Children write to stderr too, so stdout carries only the result.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Node's global fetch, the default; tests pass a stub registry instead. */
const { fetch } = globalThis

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** A release candidate, `x.y.z-rc.N` (ADR-0014 P7): Changesets' pre mode with the tag `rc`. */
const RC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/
/** The pre-mode tag every release candidate carries; `.changeset/pre.json` must name it. */
const RC_TAG = 'rc'
const SHA = /^[0-9a-f]{40}$/
const REPOSITORY_URL = /^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/
const REGISTRY = 'https://registry.npmjs.org'
const USAGE = [
    'usage: release.mjs check',
    '       release.mjs prepare [--allow-dirty]',
    '       release.mjs publishable <version>',
    '       release.mjs preflight <version> <sha> <tarball>...',
    '       release.mjs verify-release <version>',
    '       release.mjs wait-for-checks <sha>',
    '       release.mjs checks-run <sha>',
    '       release.mjs candidate <version> <tarball>...',
    '       release.mjs candidate-notes <version> <owner/repo> <sha> <assets.json>',
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
 * `.changeset/pre.json` as Changesets 3 writes it (`changeset pre enter rc`): exactly `{"mode": "pre", "tag": "rc"}`,
 * read without a dependency (the `push` job installs none). Absent means no pre mode. Anything else, `exit` mode
 * included, fails: SSSB entered pre mode for its release candidates while the packages were private and left it at
 * P14 by deleting this file (not by `changeset pre exit`, whose `"mode": "exit"` would leave one more state for every
 * reader to know; docs/decision-log.md, 2026-11-18, P14), and nothing between is a state a release should guess at.
 * @param {string | null} text the file's contents, or null when there is none
 * @returns {{ mode: 'pre', tag: 'rc' } | null}
 */
function preStateOf(text) {
    if (text === null) return null
    let state
    try {
        state = JSON.parse(text)
    } catch {
        throw new Error('.changeset/pre.json is not JSON')
    }
    const keys = state && typeof state === 'object' ? Object.keys(state).sort().join(',') : ''
    if (keys !== 'mode,tag' || state.mode !== 'pre' || state.tag !== RC_TAG) {
        throw new Error(`.changeset/pre.json must be exactly {"mode": "pre", "tag": "${RC_TAG}"}`)
    }
    return state
}

/** The working tree's pre state (see preStateOf). */
function readPreState(root) {
    const file = path.join(root, '.changeset', 'pre.json')
    return preStateOf(existsSync(file) ? readFileSync(file, 'utf8') : null)
}

/**
 * Semver's `inc` for the three bumps Changesets files, on a version that may be a prerelease: a prerelease is
 * already on its way to the version it bumps to, so `0.2.0-rc.1` patched or minored is `0.2.0`, and only a bump past
 * that moves it further. This is `semver/functions/inc` (which Changesets 3 calls, then appends `-rc.N`) for these
 * inputs, written out so the `push` job, which installs nothing, can compute it.
 * @param {string} version `x.y.z` or `x.y.z-rc.N`
 * @param {'major' | 'minor' | 'patch'} type
 */
export function bump(version, type) {
    const [core, pre] = version.split('-')
    const [ma, mi, pa] = core.split('.').map(Number)
    const isPre = pre !== undefined
    if (type === 'major') return `${!isPre || mi !== 0 || pa !== 0 ? ma + 1 : ma}.0.0`
    if (type === 'minor') return `${ma}.${!isPre || pa !== 0 ? mi + 1 : mi}.0`
    return `${ma}.${mi}.${isPre ? pa : pa + 1}`
}

/**
 * The next release candidate's number for a group now at these versions: one past the highest `-rc.N` among them,
 * or 0 when none is a candidate. Changesets 3's `getPreVersion`, taken over a fixed group.
 * @param {string[]} versions
 */
export function nextCandidate(versions) {
    return Math.max(-1, ...versions.map((v) => Number(RC_VERSION.exec(v)?.[4] ?? -1))) + 1
}

/**
 * The version a fixed group at `current` releases for these pending bumps, as Changesets computes it: the highest
 * bump applied once to the group's version, and in pre mode `-rc.N` after it. Null when no bump releases anything.
 * Throws when the group is at more than one version, which a fixed group never is.
 * @param {string[]} current the group's versions
 * @param {string[]} bumps the pending changesets' bumps for the group (`none` releases nothing)
 * @param {boolean} pre whether pre mode is on
 */
export function impliedVersion(current, bumps, pre) {
    const versions = [...new Set(current)]
    if (versions.length !== 1) throw new Error(`the fixed group is at several versions: ${versions.join(', ')}`)
    const rank = Math.max(-1, ...bumps.map((b) => ['patch', 'minor', 'major'].indexOf(b)))
    if (rank < 0) return null
    const next = bump(versions[0], /** @type {'patch' | 'minor' | 'major'} */ (['patch', 'minor', 'major'][rank]))
    return pre ? `${next}-${RC_TAG}.${nextCandidate(versions)}` : next
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
    // Release candidates are Changesets' pre mode with the tag `rc` (ADR-0014, addendum 2026-11-18, P7): every plan
    // here is assembled with the same pre state `changeset version` reads, so `check`, `prepare` and the CLI agree.
    const pre = readPreState(root)
    const changesets = await readChangesets(root)
    const plan = (cfg) =>
        assembleReleasePlan(changesets, packages, cfg, pre ?? undefined).releases.filter((r) => r.type !== 'none')
    // In pre mode Changesets moves each changeset it consumes to `.changeset/pre/` (id `pre/<name>`) and keeps it
    // until pre mode ends; only the others are pending. OUT of pre mode (ADR-0014 P14 left it by deleting
    // `.changeset/pre.json`) Changesets counts every one, `pre/` included, and its next `changeset version` releases and
    // deletes them all: the first plain release carries the whole series of candidates
    // (`@changesets/assemble-release-plan` 7.0.0, `getRelevantChangesets`).
    const pending = pre ? changesets.filter((c) => !c.id.startsWith('pre/')) : changesets
    return { packages: packages.packages, config, fixed, changesets, pending, pre, plan }
}

/**
 * The PR check. Returns the problems (empty when the changesets are acceptable) and the plan it judged: the
 * one Changesets will apply as if every package were public, which is the only plan that can ever reach npm.
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
    // RELEASE CANDIDATES WHILE PRIVATE (ADR-0014 P7, JP 2026-11-18: a merge to main is the release decision). While
    // the group is private it never reaches npm, so every release is a candidate, `x.y.z-rc.N`, cut by a merge to main
    // and shipped as a GitHub prerelease. That takes pre mode with the tag `rc`, and a config that versions private
    // packages; without either, a merge would cut a plain version nothing can publish, or nothing at all. Once the group
    // is public (P14), pre mode is left, and a release is a plain version on npm.
    if (privacy.has(true) && privacy.size === 1) {
        if (!ws.pre) {
            problems.push(
                `the fixed group is private, so its releases are release candidates: .changeset/pre.json must be ` +
                    `{"mode": "pre", "tag": "${RC_TAG}"} (\`changeset pre enter ${RC_TAG}\`)`,
            )
        }
        if (!ws.config.privatePackages.version) {
            problems.push(
                '.changeset/config.json must version private packages ("privatePackages": { "version": true }) ' +
                    'while the fixed group is private, or a merge to main cuts no release candidate',
            )
        }
    } else if (ws.pre) {
        problems.push(
            'the fixed group is public: leave pre mode before releasing it to npm, by deleting .changeset/pre.json ' +
                '(ADR-0014 P14). Release candidates were GitHub prereleases of the private group only',
        )
    }
    // ONE VERSION FOR THE GROUP, as its manifests say. Changesets plans a fixed group from its highest version, but
    // `verify-release` reads the manifests and refuses a group at two, so a package that joins at another version would
    // pass here and stall the release after merge. A new package starts at the group's version.
    const groupVersions = [...new Set(group.map((p) => p.packageJson.version))]
    if (groupVersions.length > 1) {
        problems.push(
            `the fixed group is at several versions (${group.map((p) => `${p.packageJson.name}@${p.packageJson.version}`).join(', ')}); ` +
                'a package joins it at the version the others are at',
        )
    }
    // In pre mode Changesets moves a consumed changeset to `.changeset/pre/<name>.md`, so a pending one with a name
    // already there would overwrite it, which `verify-release` refuses after merge. Out of pre mode both are pending and
    // both would be released, but the notes would list two entries under one name. Names are never reused.
    const consumed = new Set(ws.changesets.filter((c) => c.id.startsWith('pre/')).map((c) => c.id.slice(4)))
    for (const c of ws.changesets) {
        if (consumed.has(c.id)) {
            problems.push(
                `.changeset/${c.id}.md has the name of a changeset an earlier release candidate consumed ` +
                    `(.changeset/pre/${c.id}.md); give it another name`,
            )
        }
    }
    // Only the PENDING ones: in pre mode a consumed changeset (`pre/`) was released with its candidate, and a rule or a
    // group that changed since must not turn that record red on every later PR. Out of pre mode the `pre/` ones are
    // pending again, and the next release reads them: they are judged like any other.
    for (const changeset of ws.pending) {
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
    // A changeset naming an ignored package beside the group is one Changesets refuses to plan at all ("mixed
    // changeset"), so with that already reported there is no plan to judge.
    if (ws.changesets.some((c) => c.releases.some((r) => !ws.fixed.has(r.name)))) {
        return { problems, plan: [], changesets: ws.pending.length }
    }
    // Only the fixed group is ever released; anything else in the plan (an app the config does not ignore) is reported
    // by `prepare`, which refuses it. A candidate is `0.x.y-rc.N`, a release `0.x.y`: nothing reaches 1.0.0.
    const asPublished = ws
        .plan({ ...ws.config, privatePackages: { version: true, tag: false } })
        .filter((r) => ws.fixed.has(r.name))
    const shape = ws.pre ? RC_VERSION : PLAIN_VERSION
    for (const release of asPublished) {
        if (!shape.test(release.newVersion) || major(release.newVersion) >= 1) {
            problems.push(
                `the release plan takes ${release.name} from ${release.oldVersion} to ${release.newVersion}; ` +
                    `nothing reaches 1.0.0 from an ordinary PR, and ${ws.pre ? 'a candidate is 0.x.y-rc.N' : 'a release is 0.x.y'}`,
            )
        }
    }
    return { problems, plan: asPublished, changesets: ws.pending.length }
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
 * @param {{ allowDirty?: boolean, fetchImpl?: typeof fetch }} [options]
 */
export async function prepare(root, { allowDirty = false, fetchImpl = fetch } = {}) {
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
        // Every pending changeset is empty (`---` `---`), so nothing is versioned, consumed or tagged.
        return { release: false, reason: 'the pending changesets release nothing: they are empty' }
    }
    const strays = releases.filter((r) => !ws.fixed.has(r.name)).map((r) => r.name)
    if (strays.length > 0) {
        throw new Error(`only the fixed group is released, and the plan also releases ${strays.join(', ')}`)
    }
    const planned = new Set(releases.map((r) => r.newVersion))
    const [version] = planned
    const shape = ws.pre ? RC_VERSION : PLAIN_VERSION
    if (planned.size !== 1 || !shape.test(version) || major(version) !== 0) {
        throw new Error(
            `the plan must release one 0.x ${ws.pre ? 'release candidate' : 'version'}, got ` +
                releases.map((r) => `${r.name}@${r.newVersion}`).join(', '),
        )
    }
    // The `push` job recomputes the version from the commit alone (verifyRelease), with no Changesets to ask, so the
    // two must agree before anything is changed: a disagreement found there would come after the plan was accepted.
    // From the manifests, not the plan: Changesets gives every member of a fixed group the group's highest version as
    // its `oldVersion`, which would hide a member at another one from this cross-check.
    const expected = impliedVersion(
        ws.packages.filter((p) => ws.fixed.has(p.packageJson.name)).map((p) => p.packageJson.version),
        ws.pending.flatMap((c) => c.releases.filter((r) => ws.fixed.has(r.name)).map((r) => r.type)),
        ws.pre !== null,
    )
    if (expected !== version) {
        throw new Error(`Changesets plans ${version}, but the release's own check would expect ${expected}`)
    }
    if (git(root, ['tag', '--list', `v${version}`]).trim()) {
        throw new Error(`the tag v${version} already exists; a release is never cut twice`)
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
    // A candidate is judged by the release it leads to (`0.2.0-rc.1` by `0.2.0`), which must be newer than any release.
    const target = version.split('-')[0]
    const floors = [['the latest stable tag', latestStableTag(root)]]
    for (const r of releases) floors.push([`npm's latest ${r.name}`, await npmLatest(r.name, fetchImpl)])
    for (const [what, floor] of floors) {
        if (floor !== null && PLAIN_VERSION.test(floor) && compareVersions(target, floor) <= 0) {
            throw new Error(
                `the changesets plan ${version}, which is not newer than ${what} (${floor}); a release never goes backwards`,
            )
        }
    }

    // THE RELEASE NOTES, from the changesets as they are NOW: `changeset version` consumes them (deletes them, or in pre
    // mode moves them to `.changeset/pre/`, where they are no longer pending). They are judged here,
    // before anything is changed, so a changeset that is not a readable entry stops the release instead of failing it
    // after its plan was accepted. The package names and bumps are judged by `check` above, as in `check` itself.
    // The notes are a new file in the release commit, which verifyRelease accepts at exactly this path.
    const { releaseNotes } = await import('./release-notes.mjs')
    const { markdown } = releaseNotes(root, { version, judgePackages: false })
    mkdirSync(path.join(root, 'docs', 'releases'), { recursive: true })
    writeFileSync(path.join(root, notesPath(version)), markdown)

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
    // Consumed means deleted, or in pre mode moved to `.changeset/pre/`: either way, no longer pending.
    if (after.pending.length > 0) wrong.push(`changesets remain: ${after.pending.map((c) => c.id).join(', ')}`)
    if (wrong.length > 0) throw new Error(`after \`changeset version\` to ${version}: ${wrong.join('; ')}`)
    return { release: true, version, packages: releases.map((r) => r.name).sort(), notes: notesPath(version) }
}

/**
 * The packages a tag publishes: every non-private workspace package, each of which must be in the fixed group
 * and at the tag's version. Empty were every package private, which made the publish a no-op until P14.
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
 * A packed tarball's own manifest, or null when it is not laid out as `pnpm pack` lays one out. npm reads the manifest
 * from whatever the first directory is called, so a tarball laid out any other way could show a check one manifest
 * and an installer another. Every entry must be a file or a directory at a normalized path under `package/`: no `..`,
 * `.` or empty segment that an extractor could resolve onto another entry, and no link.
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
function packedManifest(file) {
    const tar = (args) => execFileSync('tar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 2] })
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
        return null
    }
    return JSON.parse(tar(['-xzOf', file, 'package/package.json']))
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
    for (const file of files) {
        const manifest = packedManifest(file)
        if (manifest === null) {
            problems.push(`${file} is not laid out as one package/ of plain files with one package/package.json`)
            continue
        }
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

/** The package whose tarball carries the release stamp. */
const KIT_NAME = '@sssb/kit'

/**
 * The commit `@sssb/kit`'s release stamp (`package/dist/release.json`, written by its prepack) names, or null when the
 * tarball holds none or one that names no commit. Read only from a tarball `packedManifest` accepted.
 * @param {string} file
 * @returns {string | null}
 */
function releaseStamp(file) {
    const listed = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 2] }).split('\n')
    if (!listed.includes('package/dist/release.json')) return null
    try {
        const { commit } = JSON.parse(
            execFileSync('tar', ['-xzOf', file, 'package/dist/release.json'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 2],
            }),
        )
        return typeof commit === 'string' && SHA.test(commit) ? commit : null
    } catch {
        return null
    }
}

/**
 * THE RELEASE CANDIDATE'S ASSETS, checked before anything is attested or attached (ADR-0014 P7). The tarballs are
 * the ones `checks`' pack-and-consume job packed and tested on this very commit, handed over as that run's artifact,
 * never packed again here. They must be exactly the fixed group as this commit's `packages/` holds it, one tarball
 * each, laid out as `pnpm pack` lays one out, each at the candidate's version, and `@sssb/kit`'s release stamp
 * (`dist/release.json`, P13) must name this commit, which `sssb doctor` holds an adopter's pins to. Private is
 * expected: a candidate is cut only of the private group. Returns `[{name, file, size, sha256, sha512}]` by name, `sha512` in the
 * `sha512-<base64>` form a lockfile's `integrity` takes. Needs no installed dependency.
 * @param {string} root the release commit's checkout
 * @param {string} version
 * @param {string[]} files
 */
export function candidate(root, version, files) {
    if (!RC_VERSION.test(version) || major(version) !== 0) throw new Error(`not a release candidate: '${version}'`)
    if (files.length === 0) throw new Error('no tarballs to attach')
    const inFixedGroup = fixedGroupMatcher(root)
    const group = new Map()
    for (const dir of readdirSync(path.join(root, 'packages'), { withFileTypes: true })) {
        const file = path.join(root, 'packages', dir.name, 'package.json')
        if (!dir.isDirectory() || !existsSync(file)) continue
        const manifest = JSON.parse(readFileSync(file, 'utf8'))
        if (inFixedGroup(manifest.name)) group.set(manifest.name, manifest.version)
    }
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    const problems = []
    const assets = []
    for (const file of files) {
        const manifest = packedManifest(file)
        if (manifest === null) {
            problems.push(`${file} is not laid out as one package/ of plain files with one package/package.json`)
            continue
        }
        const { name } = manifest
        if (typeof name !== 'string' || !group.has(name)) {
            problems.push(`${file} holds ${String(name)}, which is not in this commit's fixed group`)
            continue
        }
        if (assets.some((a) => a.name === name)) problems.push(`${name} is packed twice`)
        if (manifest.version !== version) problems.push(`${file} holds ${name}@${manifest.version}, not ${version}`)
        // The name `pnpm pack` gives it: the file name becomes a release asset's name and a URL in the notes.
        const expectedFile = `${name.slice(1).replace('/', '-')}-${version}.tgz`
        if (path.basename(file) !== expectedFile) problems.push(`${file} holds ${name}, so is named ${expectedFile}`)
        if (group.get(name) !== version) problems.push(`this commit has ${name} at ${group.get(name)}, not ${version}`)
        if (name === KIT_NAME) {
            const stamp = releaseStamp(file)
            if (stamp !== head)
                problems.push(`${file}: ${name}'s release stamp names ${stamp ?? 'no commit'}, not ${head}`)
        }
        const bytes = readFileSync(file)
        assets.push({
            name,
            file: path.basename(file),
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sha512: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        })
    }
    for (const name of group.keys()) {
        if (!assets.some((a) => a.name === name)) problems.push(`no tarball holds ${name}, which this commit releases`)
    }
    if (new Set(assets.map((a) => a.file)).size !== assets.length) problems.push('two tarballs share a file name')
    if (problems.length > 0) throw new Error(problems.join('\n'))
    return assets.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Markdown with its soft line breaks joined: a GitHub release's body is rendered as GitHub renders a comment, where
 * every newline inside a paragraph is a hard break, so notes wrapped at a fixed width would show ragged. Joins a line
 * onto the one before when both are plain wrapped text in the same paragraph or list item. Leaves alone fenced code (a
 * fence closes, as CommonMark has it, on a bare line of the same character at least as long), indented code, tables
 * and any line holding a `|`, headings and setext underlines, quotes, HTML, link definitions, blank lines, the start
 * of every list item, and a line after a hard break (two trailing spaces or a `\`).
 * @param {string} markdown
 */
export function unwrap(markdown) {
    // Conservative by design: a line left unjoined costs one line break in the rendered notes, and a line joined that
    // should not be can change code an adopter copies, so anything but plain wrapped prose is left alone.
    const out = []
    /** The open fence's character and length (CommonMark: closed by the same character, at least as long). */
    let fence = null
    const opener = /^ {0,3}(`{3,}|~{3,})/
    // a line that starts something, or that must stay on its own line
    const own = /^\s*([-*+] |\d+[.)] |#|>|<|\[[^\]]*\]:|=+\s*$|-+\s*$)/
    for (const line of markdown.split('\n')) {
        const open = opener.exec(line)?.[1]
        if (fence) {
            out.push(line)
            if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = null
            continue
        }
        if (open) {
            fence = open
            out.push(line)
            continue
        }
        const prev = out.at(-1)
        const joinable =
            prev !== undefined &&
            line.trim() !== '' &&
            prev.trim() !== '' &&
            !own.test(line) &&
            !/^\s*(#|<|\[[^\]]*\]:)/.test(prev) &&
            !line.includes('|') &&
            !prev.includes('|') &&
            // indented code (four spaces or a tab)
            !/^( {4}|\t)/.test(line) &&
            !/^( {4}|\t)/.test(prev.replace(/^\s*([-*+]|\d+[.)]) /, '')) &&
            // a hard break at the end of the line before
            !/( {2}|\\)$/.test(prev)
        if (joinable) out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`
        else out.push(line)
    }
    return out.join('\n')
}

/**
 * The GitHub prerelease's notes: the release notes the release commit carries (`docs/releases/v<version>.md`, written
 * by `prepare` and checked by `verify-release`), then how to install each tarball by URL, its sha512, and how to
 * verify the attestation. An adopter commits the lockfile and installs with `--frozen-lockfile`: a release asset can be
 * replaced under the same URL, and the lockfile's integrity is what pins the bytes (ADR-0014 part 10).
 * @param {string} root the release commit's checkout
 * @param {string} version
 * @param {string} repo `owner/name`
 * @param {string} sha the release commit
 * @param {{ name: string, file: string, sha512: string }[]} assets as `candidate` returns them
 */
export function candidateNotes(root, version, repo, sha, assets) {
    if (!RC_VERSION.test(version)) throw new Error(`not a release candidate: '${version}'`)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not a repository: '${repo}'`)
    if (!SHA.test(sha)) throw new Error(`not a commit: '${sha}'`)
    const notes = readFileSync(path.join(root, notesPath(version)), 'utf8')
    if (!notes.startsWith(`# Release notes: v${version}\n`)) {
        throw new Error(`${notesPath(version)} is not the release notes of v${version}`)
    }
    const url = (/** @type {string} */ file) => `https://github.com/${repo}/releases/download/v${version}/${file}`
    // The generator is run, never depended on: it is left out of the dependencies, and said how to run.
    const generator = assets.find((a) => a.name === GENERATOR)
    const libraries = assets.filter((a) => a.name !== GENERATOR)
    const out = [
        notes.trimEnd(),
        '',
        '## Installing this release candidate',
        '',
        `A release candidate is a GitHub prerelease of \`${repo}\`, cut from \`${sha}\`; nothing is on npm. Each package`,
        'is a tarball installed by URL. Commit the lockfile and install with `--frozen-lockfile`: a release asset can be',
        "replaced under the same URL, and the lockfile's `integrity`, checked against the sha512 below, is what pins the",
        'bytes.',
        '',
        'In each workspace package that uses one, depend on it by its URL; a package that uses `@sssb/cdk` also depends on',
        "`@sssb/tools`, cdk's peer. No SSSB package depends on another, so this needs no `overrides`, and pnpm's default",
        '`blockExoticSubdeps` stays on:',
        '',
        '```json',
        JSON.stringify(Object.fromEntries(libraries.map((a) => [a.name, url(a.file)])), null, 4),
        '```',
        '',
        ...(generator
            ? [
                  `\`${GENERATOR}\` is the generator, which no workspace depends on: to start a new workspace on this`,
                  'candidate, download every tarball below into one directory, extract the generator there, and run it with',
                  'that directory as its packages (its workspace then depends on them by `file:` path):',
                  '',
                  '```sh',
                  `tar -xzf ${generator.file}`,
                  'node package/bin/create.js <dir> --sssb . --repo <owner/name> --owner <@handle>',
                  '```',
                  '',
              ]
            : []),
        '| Package | Tarball | sha512 |',
        '| --- | --- | --- |',
        ...assets.map((a) => `| \`${a.name}\` | [\`${a.file}\`](${url(a.file)}) | \`${a.sha512}\` |`),
        '',
        "Each tarball is attested by this repository's release workflow, on this candidate's tag, from this commit:",
        '',
        '```sh',
        `gh attestation verify <tarball> --repo ${repo} --signer-workflow ${repo}/.github/workflows/release.yml \\`,
        `    --source-ref refs/tags/v${version} --source-digest ${sha}`,
        '```',
        '',
    ]
    return unwrap(out.join('\n'))
}

/** The fixed group's generator (ADR-0014 P12), which an adopter runs rather than installs. */
const GENERATOR = '@sssb/create'

const CHANGESET_FILE = /^\.changeset\/[^/]+\.md$/
/** A changeset an earlier release candidate consumed: pending again once pre mode is left (ADR-0014 P14). */
const PRE_CHANGESET_FILE = /^\.changeset\/pre\/[^/]+\.md$/
const MANIFEST = /^packages\/[^/]+\/package\.json$/
const CHANGELOG = /^packages\/[^/]+\/CHANGELOG\.md$/

/** Where a release's notes live in its release commit. */
const notesPath = (/** @type {string} */ version) => `docs/releases/v${version}.md`

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
export function changesetReleases(text, where) {
    // What scripts/release-notes.mjs's lint accepts, which is what Changesets reads: a BOM or blank lines first, `#`
    // comments, a quoted bump. A reader stricter than the lint would fail a release in the `push` job, after its plan
    // was accepted (tests/tooling/release-notes.test.ts holds the two together).
    const frontmatter = /^\uFEFF?\s*---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text)
    if (!frontmatter) throw new Error(`${where}: no frontmatter`)
    return (frontmatter[1] ?? '')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+#.*$/, '').trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
            const m = /^(["']?)([^"'\s:][^"']*?)\1\s*:\s*(["']?)(major|minor|patch|none)\3$/.exec(line)
            if (!m) throw new Error(`${where}: cannot read "${line}"`)
            return { name: m[2], type: m[4] }
        })
}

/**
 * The `push` job's check of the staged release, before it mints the release app's token. The release was
 * prepared in another job, by dependency code, so nothing it says is taken on trust. From HEAD alone this
 * works out what the release must be: every pending changeset consumed, every fixed-group manifest it releases (the
 * public ones, or in pre mode the private group's, whose candidate it is) under
 * packages/ (where `check` keeps the group) moved
 * to the one version those changesets imply. The index may then differ from HEAD by exactly that: the
 * changesets deleted (in pre mode, each also added unchanged as `.changeset/pre/<name>.md`, where Changesets moves
 * it), each of those manifests changed in its version line and nowhere else, plain-file changelogs beside them, and
 * one new plain file, the release notes `docs/releases/v<version>.md`, which must begin `# Release notes: v<version>`
 * and is required. The version must also be newer than every `vX.Y.Z` tag, judged by the release it leads to, and
 * its own tag must not exist yet. Needs no installed dependency.
 */
export function verifyRelease(root, version) {
    const problems = []
    const tracked = git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
    const atHead = (file) => git(root, ['show', `HEAD:${file}`])
    // Pre mode as HEAD has it: a release candidate (`x.y.z-rc.N`) of the private group, or a plain release.
    const pre = preStateOf(tracked.includes('.changeset/pre.json') ? atHead('.changeset/pre.json') : null)
    const shape = pre ? RC_VERSION : PLAIN_VERSION
    if (!shape.test(version) || major(version) !== 0) {
        problems.push(`not a 0.x ${pre ? 'release candidate' : 'release'} version: '${version}'`)
    }
    if (git(root, ['diff', '--name-only']).trim() || git(root, ['ls-files', '--others', '--exclude-standard']).trim()) {
        problems.push('the tree holds changes that are not staged')
    }
    const inFixedGroup = fixedGroupMatcher(root, 'HEAD')

    // What HEAD says the release is: the public group's release, or, in pre mode, the private group's candidate.
    const released = new Map()
    for (const file of tracked.filter((f) => MANIFEST.test(f))) {
        const manifest = JSON.parse(atHead(file))
        if (!inFixedGroup(manifest.name)) continue
        const priv = isPrivate(manifest, file)
        if (pre && !priv) problems.push(`${file} is public, and a release candidate is cut only of the private group`)
        if (pre || !priv) released.set(file, manifest.version)
    }
    // Pending is `.changeset/<name>.md`; in pre mode the ones already consumed sit in `.changeset/pre/` and are not. Out
    // of pre mode (from P14) Changesets releases those too, and the release deletes them as it deletes the others.
    const pending = tracked.filter(
        (f) => (CHANGESET_FILE.test(f) || (!pre && PRE_CHANGESET_FILE.test(f))) && isChangesetName(path.basename(f)),
    )
    const bumps = []
    for (const file of pending) {
        for (const r of changesetReleases(atHead(file), file)) {
            if (!inFixedGroup(r.name)) problems.push(`${file} names ${r.name}, which is not in the fixed group`)
            else bumps.push(r.type)
        }
    }
    if (released.size === 0)
        problems.push('no fixed-group package is released (none is public, or in pre mode none exists)')
    else {
        try {
            const expected = impliedVersion([...released.values()], bumps, pre !== null)
            if (expected === null) problems.push('the pending changesets release nothing')
            else if (expected !== version) problems.push(`the pending changesets release ${expected}, not ${version}`)
        } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error))
        }
    }

    // What the index holds. `--raw` gives old mode, new mode, status and path, so a symlink, an executable or a
    // gitlink cannot pass as a plain file.
    const deleted = new Set()
    const moved = new Set()
    const bumped = new Set()
    let notes = false
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
        // In pre mode a consumed changeset is moved, not deleted: `.changeset/pre/<name>.md`, a new plain file holding
        // exactly what `.changeset/<name>.md` held at HEAD, which must itself be deleted (checked below).
        const original = `.changeset/${path.posix.basename(file)}`
        if (pre && status === 'A' && dir === '.changeset/pre' && plain(newMode) && pending.includes(original)) {
            if (git(root, ['show', `:${file}`]) !== atHead(original)) {
                problems.push(`${file} must hold exactly what ${original} held`)
            }
            moved.add(original)
            continue
        }
        // The release notes: one new plain file, at exactly this path. Its words come from reviewed changesets, and
        // this lone copy cannot regenerate them to compare (it has no sibling module), so what is checked is that it is
        // the notes of THIS version. The package changelogs below are accepted on the same terms.
        if (file === notesPath(version) && status === 'A' && plain(newMode)) {
            const staged = git(root, ['show', `:${file}`])
            if (!staged.startsWith(`# Release notes: v${version}\n`)) {
                problems.push(`${file} must be the release notes of v${version}`)
            }
            notes = true
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
    if (!notes) problems.push(`the release notes ${notesPath(version)} are not staged`)
    for (const file of pending) {
        if (!deleted.has(file)) problems.push(`${file} is not consumed`)
        else if (pre && !moved.has(file)) problems.push(`${file} is deleted, not moved to .changeset/pre/`)
    }
    for (const file of released.keys()) if (!bumped.has(file)) problems.push(`${file} is not moved to ${version}`)
    // Judged by the release it leads to: `0.2.0-rc.0` must still be ahead of every release, as `0.2.0` would be.
    const tag = latestStableTag(root)
    const target = version.split('-')[0]
    if (tag !== null && PLAIN_VERSION.test(target) && compareVersions(target, tag) <= 0) {
        problems.push(`${version} is not newer than v${tag}`)
    }
    if (git(root, ['tag', '--list', `v${version}`]).trim()) problems.push(`the tag v${version} already exists`)
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
                // The run's id is handed back for `checks-run`, which downloads that run's tarballs.
                if (run.conclusion === 'success') return run.id
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
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--allow-dirty')) throw new Error(USAGE)
        console.log(JSON.stringify(await prepare(root, { allowDirty: rest.length === 1 })))
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
    if (command === 'checks-run' && rest.length === 1) {
        // The gate, then the id of the run that passed it, whose artifact holds the tarballs it tested.
        const { GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env
        const id = await waitForChecks({ repo, sha: rest[0], token })
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`the run that passed checks on ${rest[0]} has no id`)
        console.log(`run ${id}`)
        return
    }
    if (command === 'candidate' && rest.length >= 2) {
        const [version, ...files] = rest
        console.log(JSON.stringify(candidate(root, version, files)))
        return
    }
    if (command === 'candidate-notes' && rest.length === 4) {
        const [version, repo, sha, assets] = rest
        process.stdout.write(candidateNotes(root, version, repo, sha, JSON.parse(readFileSync(assets, 'utf8'))))
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
