import path from 'node:path'
import { build, type Metafile, type Plugin } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * A real deployment has no seed: its people are the identity provider's and its rows the database's. So no job
 * handler, framework or app, may reach a seed module by a static import, which would load the seed in every
 * deployment and let a handler read from it. A dynamic `import()` is allowed: that is how simulated-only code (the fake
 * auth adapter's locales, say) is reached behind `isSimulated`, and a real deployment never takes it.
 *
 * Read from esbuild's own account of each seam's `jobs` module (what `jobHandlers` registers, and everything those
 * handlers import), for the fixture and both apps: every static edge is followed from the module, through the kit
 * and the app alike, and none may land in a seed module. Packages outside the workspace are left external; they
 * hold no seed.
 */
const REPO = path.resolve(__dirname, '../..')

const SEAMS = [
    { name: 'the fixture', seam: 'packages/kit/test-fixture/app-config', tsconfig: 'tsconfig.json' },
    { name: 'the showcase', seam: 'apps/showcase/src/app-config', tsconfig: 'apps/showcase/tsconfig.json' },
    { name: 'the starter', seam: 'apps/starter/src/app-config', tsconfig: 'apps/starter/tsconfig.json' },
]

/** A seed module: a seam's `seed.ts`, the fixture's seed, the showcase's seed package, an app's own `src/seed`. */
const SEED =
    /(^|\/)app-config\/seed\.ts$|(^|\/)test-fixture\/seed\.ts$|(^|\/)packages\/seed\/|(^|\/)apps\/[^/]+\/src\/seed\//

/** Bare specifiers that are not the workspace's own stay external. */
const workspaceOnly: Plugin = {
    name: 'workspace-only',
    setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
            /^(@sssb\/|@app\/|@\/)/.test(args.path) ? undefined : { path: args.path, external: true },
        )
    },
}

/** Every input reached from `entry` by static imports alone, with the chain that reached it. */
function staticReach(metafile: Metafile, entry: string): Map<string, string[]> {
    const reached = new Map<string, string[]>([[entry, [entry]]])
    const queue = [entry]
    while (queue.length > 0) {
        const file = queue.shift() as string
        for (const edge of metafile.inputs[file]?.imports ?? []) {
            if (edge.external || edge.kind === 'dynamic-import') continue
            if (reached.has(edge.path)) continue
            reached.set(edge.path, [...(reached.get(file) ?? []), edge.path])
            queue.push(edge.path)
        }
    }
    return reached
}

describe('job handlers reach no seed module by a static import', () => {
    it.each(SEAMS)(
        'in $name',
        async ({ seam, tsconfig }) => {
            const result = await build({
                entryPoints: [path.join(REPO, seam, 'jobs.ts')],
                absWorkingDir: REPO,
                bundle: true,
                write: false,
                platform: 'node',
                format: 'esm',
                metafile: true,
                logLevel: 'silent',
                tsconfig: path.join(REPO, tsconfig),
                alias: { '@sssb/app-config': path.join(REPO, seam) },
                plugins: [workspaceOnly],
            })
            const entry = path.relative(REPO, path.join(REPO, seam, 'jobs.ts'))
            const reached = staticReach(result.metafile, entry)
            // The walk saw the handlers: the framework's digest handler is registered in every seam.
            expect([...reached.keys()].some((file) => file.endsWith('jobs/digest-email.ts'))).toBe(true)
            const seeds = [...reached.entries()]
                .filter(([file]) => SEED.test(file))
                .map(([, chain]) => chain.join(' -> '))
            expect(seeds).toEqual([])
        },
        60_000,
    )
})
