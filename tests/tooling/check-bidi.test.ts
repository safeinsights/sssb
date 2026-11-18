/**
 * The Trojan Source scan (.github/scripts/check-bidi.sh), run against real scratch git repositories so each
 * case is a gate SEEN to fail, not one that has only ever passed. Every bidi character is built with
 * String.fromCharCode: a literal one in this file would trip the very scan it tests (and hide in review).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestTmpDir } from '../support/tmp-dir'

const SCRIPT = fileURLToPath(new URL('../../.github/scripts/check-bidi.sh', import.meta.url))
const RLO = String.fromCharCode(0x202e)
/** The nine reordering codepoints the scan covers: U+202A-202E and U+2066-2069. */
const NINE = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]

/** The parent's environment minus anything that would point git at another repository. */
function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    return { ...env, ...extra }
}

/** A scratch directory holding a copy of the script, as `.github/scripts/check-bidi.sh` in a checkout. */
function scratch(): string {
    const dir = makeTestTmpDir('check-bidi-')
    mkdirSync(path.join(dir, '.github/scripts'), { recursive: true })
    copyFileSync(SCRIPT, path.join(dir, '.github/scripts/check-bidi.sh'))
    return dir
}

function git(dir: string, ...args: string[]): void {
    const result = spawnSync('git', args, {
        cwd: dir,
        env: baseEnv({
            // Keep the scratch repository from reading the developer's own config or hooks.
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
        }),
        encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** A real scratch repository, the script tracked beside whatever `files` maps (path to contents). */
function repo(files: Record<string, string> = {}): string {
    const dir = scratch()
    git(dir, 'init', '--quiet')
    writeFileSync(path.join(dir, 'clean.txt'), 'nothing unusual here\n')
    for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(dir, name), contents)
    git(dir, 'add', '-A')
    return dir
}

function scan(dir: string, env: Record<string, string | undefined> = {}) {
    const result = spawnSync('bash', ['.github/scripts/check-bidi.sh'], {
        cwd: dir,
        env: baseEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir), ...env }),
        encoding: 'utf8',
    })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

describe('check-bidi.sh', () => {
    it('passes a clean repository (exit 0, nothing flagged)', () => {
        const { status, out } = scan(repo())
        expect(status, out).toBe(0)
        expect(out).toContain('No bidirectional unicode control characters')
    })

    it('passes a repository holding non-bidi non-ASCII text, so the scan is not just rejecting all of it', () => {
        const { status, out } = scan(repo({ 'copy.txt': 'café — 日本語 ‏\n' }))
        expect(status, out).toBe(0)
    })

    it('fails a tracked file whose CONTENTS hold U+202E (exit 1, names the file)', () => {
        const { status, out } = scan(repo({ 'evil.ts': `const access = "user${RLO} // admin"\n` }))
        expect(status).toBe(1)
        expect(out).toContain('evil.ts')
        expect(out).toContain('file contents')
    })

    it.each(NINE.map((cp) => [cp.toString(16).toUpperCase(), cp] as const))(
        'catches U+%s in file CONTENTS',
        (_hex, codepoint) => {
            const { status, out } = scan(repo({ 'evil.md': `before ${String.fromCharCode(codepoint)} after\n` }))
            expect(status, out).toBe(1)
            expect(out).toContain('evil.md')
        },
    )

    it('fails a tracked file NAMED with U+202E, whose contents are clean (exit 1, filename half)', () => {
        const { status, out } = scan(repo({ [`report${RLO}gnp.ts`]: 'export {}\n' }))
        expect(status).toBe(1)
        expect(out).toContain('FILENAME')
    })

    it.each(NINE.map((cp) => [cp.toString(16).toUpperCase(), cp] as const))(
        'catches U+%s in a FILENAME (the byte pattern covers all nine)',
        (_hex, codepoint) => {
            const { status, out } = scan(repo({ [`name${String.fromCharCode(codepoint)}x.txt`]: 'clean\n' }))
            expect(status, out).toBe(1)
            expect(out).toContain('FILENAME')
        },
    )

    it('does not scan an untracked file (the scan reads what git tracks)', () => {
        const dir = repo()
        writeFileSync(path.join(dir, 'untracked.txt'), `x${RLO}y\n`)
        expect(scan(dir).status).toBe(0)
    })

    it('FAILS CLOSED when the directory is not a git repository (never reads as clean)', () => {
        const { status, out } = scan(scratch())
        expect(status).not.toBe(0)
        expect(out).toContain('did not run')
    })

    it('keeps working under a parent LC_ALL=C: still passes clean and still catches content (the script pins its own locale)', () => {
        expect(scan(repo(), { LC_ALL: 'C' }).status).toBe(0)
        const { status, out } = scan(repo({ 'evil.ts': `x${RLO}y\n` }), { LC_ALL: 'C' })
        expect(status, out).toBe(1)
        expect(out).toContain('evil.ts')
    })

    it('keeps working with no locale at all (LC_ALL and LANG unset)', () => {
        const { status, out } = scan(repo({ 'evil.ts': `x${RLO}y\n` }), { LC_ALL: undefined, LANG: undefined })
        expect(status, out).toBe(1)
        expect(out).toContain('evil.ts')
    })
})
