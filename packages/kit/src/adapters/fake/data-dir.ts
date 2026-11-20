import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * The directory all fake-adapter state lives under: APP_DATA_DIR, else `.data/` (gitignored), as an absolute path (a
 * relative APP_DATA_DIR is read against the working directory). Absolute because fake storage keeps a key inside its
 * directory by comparing resolved paths. Creates nothing.
 */
export function dataRoot(): string {
    const dir = process.env['APP_DATA_DIR']
    if (dir === undefined) return path.join(process.cwd(), '.data')
    return absolute(dir)
}

/**
 * `dir` as a normalised absolute path, against the working directory when it is relative. Written out by hand, because
 * of what a build showed: with `path.resolve(<APP_DATA_DIR>)` here, and again with `path.join(process.cwd(), <it>)` or
 * `path.normalize(<it>)`, Next's file tracer copied this whole directory's TypeScript source into the standalone
 * server (pack and consume fails on it); with this function it copies none. Other path calls on runtime values in
 * this directory do not trip it, so the trigger is narrower than "any path call": keep the environment value out of
 * one. On Windows a UNC root and a drive-relative value (`D:rel`) are not supported.
 */
function absolute(dir: string): string {
    const from = path.isAbsolute(dir) ? dir : `${process.cwd()}${path.sep}${dir}`
    // A backslash separates only where it is the platform's separator: on POSIX it is a legal file-name character.
    const separators = path.sep === '\\' ? /[\\/]+/ : /\/+/
    const parts: string[] = []
    for (const part of from.split(separators)) {
        if (part === '.' || (part === '' && parts.length > 0)) continue
        if (part === '..') {
            if (parts.length > 1) parts.pop()
            continue
        }
        parts.push(part)
    }
    return parts.length === 1 ? `${parts[0]}${path.sep}` : parts.join(path.sep)
}

/** A directory under the fake adapters' data root, created if missing. Tests point APP_DATA_DIR at a tmp dir. */
export function dataDir(...segments: string[]): string {
    const dir = path.join(dataRoot(), ...segments)
    mkdirSync(dir, { recursive: true })
    return dir
}

/**
 * Points every fake adapter at `dir` (undefined: back to the default) by ASSIGNING APP_DATA_DIR, and returns the
 * value it replaced. For a harness that ships in a test suite and so runs under an adopter's Vitest config: a
 * `vi.stubEnv` there is undone before every test by `unstubEnvs: true`, which would point the next test at the
 * working directory's `.data`, the developer's own world.
 */
export function setDataRoot(dir: string | undefined): string | undefined {
    const previous = process.env['APP_DATA_DIR']
    if (dir === undefined) delete process.env['APP_DATA_DIR']
    else process.env['APP_DATA_DIR'] = dir
    return previous
}
