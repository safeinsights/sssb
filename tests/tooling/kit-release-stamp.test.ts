import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { UNPUSHED_PIN_ENV } from '../../packages/create/src/template.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `@sssb/kit`'s release stamp (packages/kit/scripts/stamp-release.mjs, ADR-0014 part 5, P13): `dist/release.json` names
 * the commit the package is packed from, which `sssb doctor` compares with the workspace's workflow and marketplace
 * pins. Run against a STAND-IN repository holding a copy of the script, so a test can dirty it without touching this
 * one.
 */
const REPO = path.resolve(__dirname, '../..')
const SCRIPT = path.join(REPO, 'packages/kit/scripts/stamp-release.mjs')

/** git and the packing, never pointed at this repository by a hook's environment, and with no opt-out set. */
function cleanEnv(extra: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of [UNPUSHED_PIN_ENV, 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete env[name]
    return { ...env, ...extra }
}
const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })

/** A repository with packages/kit (src, package.json, the script), all committed; its kit directory. */
function standIn() {
    const repo = makeTestTmpDir('kit-stamp-')
    const kit = path.join(repo, 'packages/kit')
    mkdirSync(path.join(kit, 'src'), { recursive: true })
    mkdirSync(path.join(kit, 'scripts'), { recursive: true })
    cpSync(SCRIPT, path.join(kit, 'scripts/stamp-release.mjs'))
    writeFileSync(path.join(kit, 'package.json'), '{"name":"@sssb/kit"}\n')
    writeFileSync(path.join(kit, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n')
    git(repo, ['init', '-q'])
    git(repo, ['add', '-A'])
    git(repo, [
        ...['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'],
        ...['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'x'],
    ])
    return { kit, head: git(repo, ['rev-parse', 'HEAD']).trim() }
}

const stamp = (kit: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/stamp-release.mjs'], { cwd: kit, encoding: 'utf8', env: cleanEnv(env) })
const stamped = (kit: string) => path.join(kit, 'dist/release.json')

describe("@sssb/kit's release stamp", () => {
    it('is written when the package is packed, after the build that empties dist/', () => {
        const manifest = JSON.parse(readFileSync(path.join(REPO, 'packages/kit/package.json'), 'utf8'))
        expect(manifest.scripts.prepack).toBe('node scripts/build-testing-e2e.mjs && node scripts/stamp-release.mjs')
        // It ships with dist/, which the files allowlist already names (and the changeset gate already knows).
        expect(manifest.files).toContain('dist')
    })

    it('names the commit it is packed from', () => {
        const { kit, head } = standIn()
        const run = stamp(kit)
        expect(run.status, run.stderr).toBe(0)
        expect(JSON.parse(readFileSync(stamped(kit), 'utf8'))).toEqual({ commit: head })
    })

    it("refuses shipped sources that differ from that commit, unless @sssb/create's opt-out is set", () => {
        const { kit, head } = standIn()
        writeFileSync(path.join(kit, 'src/a.ts'), 'export const a = 2\n')
        writeFileSync(path.join(kit, 'src/new.ts'), 'export const b = 1\n')
        const refused = stamp(kit)
        expect(refused.status).toBe(1)
        expect(refused.stderr).toContain('packages/kit/src/a.ts')
        expect(refused.stderr).toContain('packages/kit/src/new.ts')
        expect(refused.stderr).toContain(UNPUSHED_PIN_ENV)
        expect(existsSync(stamped(kit))).toBe(false)

        const warned = stamp(kit, { [UNPUSHED_PIN_ENV]: '1' })
        expect(warned.status, warned.stderr).toBe(0)
        expect(warned.stderr).toMatch(/WARNING .*the shipped sources differ from HEAD/)
        expect(JSON.parse(readFileSync(stamped(kit), 'utf8'))).toEqual({ commit: head })
    })

    it('is not refused by a change outside what ships', () => {
        const { kit } = standIn()
        writeFileSync(path.join(kit, 'scripts/notes.txt'), 'scratch\n')
        expect(stamp(kit).status).toBe(0)
    })

    it('refuses to stamp outside a git checkout', () => {
        const kit = path.join(makeTestTmpDir('kit-stamp-nogit-'), 'kit')
        mkdirSync(path.join(kit, 'scripts'), { recursive: true })
        cpSync(SCRIPT, path.join(kit, 'scripts/stamp-release.mjs'))
        const run = stamp(kit, { GIT_CEILING_DIRECTORIES: path.dirname(kit) })
        expect(run.status).toBe(1)
        expect(run.stderr).toMatch(/packed from a git checkout/)
    })
})
