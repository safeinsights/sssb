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
function repo(files: Record<string, string | Buffer> = {}): string {
    const dir = scratch()
    git(dir, 'init', '--quiet')
    writeFileSync(path.join(dir, 'clean.txt'), 'nothing unusual here\n')
    for (const [name, contents] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
        writeFileSync(path.join(dir, name), contents)
    }
    git(dir, 'add', '-A')
    return dir
}

/** Runs the script (the repository's own copy) from `cwd`, which defaults to the repository's root. */
function scan(dir: string, env: Record<string, string | undefined> = {}, cwd: string = dir) {
    const result = spawnSync('bash', [path.join(dir, '.github/scripts/check-bidi.sh')], {
        cwd,
        env: baseEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir), ...env }),
        encoding: 'utf8',
    })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/**
 * A scratch directory holding an executable `git` that fails (exit 128, the status of a git fatal) when its first
 * non-option argument is `subcommand`, and otherwise runs the real git. Put it first on PATH to make one step of
 * the script fail while the rest work, which is the only way to see the script's own failure handling run.
 */
function gitFailingOn(subcommand: string): Record<string, string> {
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const dir = makeTestTmpDir('check-bidi-shim-')
    const shim = path.join(dir, 'git')
    writeFileSync(
        shim,
        [
            '#!/bin/sh',
            'for arg in "$@"; do',
            '    case "$arg" in -*) ;; *) subcommand=$arg; break ;; esac',
            'done',
            `if [ "$subcommand" = ${JSON.stringify(subcommand)} ]; then echo "shim: git $subcommand failed" >&2; exit 128; fi`,
            `exec ${JSON.stringify(real)} "$@"`,
            '',
        ].join('\n'),
        { mode: 0o755 },
    )
    return { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }
}

describe('check-bidi.sh', () => {
    it('passes a clean repository (exit 0, nothing flagged)', () => {
        const { status, out } = scan(repo())
        expect(status, out).toBe(0)
        expect(out).toContain('No bidirectional unicode control characters')
    })

    it('passes a repository holding non-bidi non-ASCII text, so the scan is not just rejecting all of it', () => {
        // U+200F (a right-to-left MARK) is deliberately outside the nine.
        const { status, out } = scan(repo({ 'copy.txt': `café 日本語${String.fromCharCode(0x200f)}\n` }))
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

    it('scans the WHOLE repository when run from a subdirectory (git grep and ls-files are cwd-relative)', () => {
        const dir = repo({ 'evil.ts': `x${RLO}y\n`, 'sub/inner.ts': 'clean\n' })
        const { status, out } = scan(dir, {}, path.join(dir, 'sub'))
        expect(status, out).toBe(1)
        expect(out).toContain('evil.ts')
    })

    it('scans a bidi FILENAME at the root when run from a subdirectory', () => {
        const dir = repo({ [`report${RLO}gnp.ts`]: 'export {}\n', 'sub/inner.ts': 'clean\n' })
        const { status, out } = scan(dir, {}, path.join(dir, 'sub'))
        expect(status, out).toBe(1)
        expect(out).toContain('FILENAME')
    })

    describe('files git is told, or tricked into, treating as binary (the PR author controls that)', () => {
        const evil = `const access = "user${RLO} // admin"\n`

        it.each(['binary', '-diff'])(
            'catches U+202E in a .ts when .gitattributes marks *.ts "%s" (git grep -I would skip it)',
            (attribute) => {
                const { status, out } = scan(repo({ '.gitattributes': `*.ts ${attribute}\n`, 'evil.ts': evil }))
                expect(status, out).toBe(1)
                expect(out).toContain('evil.ts')
                expect(out).toContain('source-type file, read as text')
            },
        )

        it('catches U+202E in a .ts that holds a NUL byte, which makes git call it binary', () => {
            const { status, out } = scan(repo({ 'evil.ts': Buffer.from(`a\0b${RLO}c\n`) }))
            expect(status, out).toBe(1)
            expect(out).toContain('evil.ts')
            expect(out).toContain('source-type file, read as text')
        })

        it('refuses a UTF-16LE .ts with a BOM and U+202E, which the UTF-8 pattern cannot match (NUL rule)', () => {
            const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`const a = "x${RLO}"\n`, 'utf16le')])
            const { status, out } = scan(repo({ 'evil.ts': utf16 }))
            expect(status, out).toBe(1)
            expect(out).toContain('evil.ts')
            expect(out).toContain('holds a NUL byte')
        })

        it('still passes a real binary file: a PNG-like blob with the bytes e2 80 ae in it', () => {
            const png = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0xe2, 0x80, 0xae, 0,
            ])
            const { status, out } = scan(repo({ 'image.png': png }))
            expect(status, out).toBe(0)
        })
    })

    describe("the script's own failure handling (each step made to fail; a clean exit here would be fail-open)", () => {
        it('fails when `git grep` fails (exit 128), never reading it as "nothing found"', () => {
            const { status, out } = scan(repo(), gitFailingOn('grep'))
            expect(status).not.toBe(0)
            expect(out).toContain('::error::bidi content scan did not run (git grep exited 128)')
        })

        it('fails when `git ls-files` fails, never reading the empty list as clean (pipefail, and the filename check)', () => {
            const { status, out } = scan(repo(), gitFailingOn('ls-files'))
            expect(status).not.toBe(0)
            expect(out).toContain('::error::bidi filename scan did not run (pipeline exited 128)')
        })

        it('fails when the filename pattern self-test does not match all nine (PERL_UNICODE=SD makes it match none)', () => {
            const { status, out } = scan(repo(), { PERL_UNICODE: 'SD' })
            expect(status).not.toBe(0)
            expect(out).toContain('::error::bidi filename pattern self-test matched 0 of 9 codepoints')
        })
    })
})
