import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** The directory all fake-adapter state lives under: APP_DATA_DIR, else `.data/` (gitignored). Creates nothing. */
export function dataRoot(): string {
    return process.env['APP_DATA_DIR'] ?? path.join(process.cwd(), '.data')
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
