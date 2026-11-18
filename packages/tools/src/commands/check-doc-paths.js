// @ts-check
// `sssb check-doc-paths`: fails when a doctrine doc cites a path that does not exist. The doc set and the rules are
// the workspace's own `sssb.docPaths` (ADR-0014 part 3), so an adopter keeps this gate the day packages/kit leaves
// the tree.
import path from 'node:path'
import process from 'node:process'
import { citedPaths, docFiles, readDocPathsConfig, resolves } from '../doc-paths.js'
import { takeOption, UsageError, workspaceRootOf } from '../app.js'

/**
 * @param {string[]} args
 * @returns {Promise<number>} 0 when every citation resolves, 1 otherwise
 */
export async function run(args) {
    const rest = [...args]
    const other = takeOption(rest, '--root')
    if (rest.length > 0)
        throw new UsageError(
            `sssb check-doc-paths: unknown argument ${rest[0]} (usage: check-doc-paths [--root <dir>])`,
        )
    const root = other === undefined ? workspaceRootOf(process.cwd()) : path.resolve(other)
    const config = readDocPathsConfig(root)

    const files = docFiles(root, config)
    let checked = 0
    let broken = 0
    for (const file of files) {
        for (const { path: cited, line } of citedPaths(file, config, root)) {
            checked++
            if (resolves(cited, root, config)) continue
            broken++
            process.stdout.write(`${file}:${line} cites \`${cited}\`\n`)
        }
    }
    process.stdout.write(
        `check-doc-paths: ${files.length} doc(s), ${checked} citation(s) checked, ${broken} broken` + '\n',
    )
    return broken === 0 ? 0 : 1
}
