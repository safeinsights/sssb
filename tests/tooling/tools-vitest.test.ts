import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { workspaceAppProjects } from '../../packages/tools/src/vitest.js'
import { makeTestTmpDir } from '../support/tmp-dir'

/**
 * `workspaceAppProjects` (@sssb/tools/vitest): a Vitest project per app of the workspace, from the one list every SSSB
 * tool reads (the root package.json's `sssb.apps`, else apps/*), so a root config keeps no copy of it. This repository's
 * own vitest.config.ts runs on it; a generated workspace's two configs do (packages/create/src/files.js).
 */
const REPO = path.resolve(__dirname, '../..')

describe('workspaceAppProjects', () => {
    it("makes appTestProject's project for each app sssb.apps names, in its order, with each app's own options", async () => {
        const seen: string[] = []
        const projects = await workspaceAppProjects({
            root: REPO,
            options: (appDir) => {
                seen.push(appDir)
                return { env: { WHICH: path.basename(appDir) } }
            },
        })
        expect(seen).toEqual([path.join(REPO, 'apps/showcase'), path.join(REPO, 'apps/starter')])
        expect(projects.map((project) => project.test?.name)).toEqual(['showcase', 'starter'])
        expect(projects.map((project) => project.test?.root)).toEqual(seen)
        expect(projects.map((project) => project.test?.env)).toEqual([{ WHICH: 'showcase' }, { WHICH: 'starter' }])
        // The preset's own: each app's seam passed explicitly.
        expect(projects[1]?.resolve?.alias).toMatchObject({
            '@sssb/app-config': path.join(REPO, 'apps/starter/src/app-config'),
        })
    })

    it('fails a workspace that names no app, and an sssb.apps entry that is not a package', async () => {
        const root = makeTestTmpDir('tools-vitest-')
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', sssb: { apps: [] } }))
        await expect(workspaceAppProjects({ root })).rejects.toThrow(/names no app/)
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', sssb: { apps: ['apps/gone'] } }))
        await expect(workspaceAppProjects({ root })).rejects.toThrow(
            /`sssb.apps` names apps\/gone, which is not a package/,
        )
        // With no sssb.apps, apps/* is the list: here, an empty one.
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        mkdirSync(path.join(root, 'apps'))
        await expect(workspaceAppProjects({ root })).rejects.toThrow(/names no app/)
    })
})
