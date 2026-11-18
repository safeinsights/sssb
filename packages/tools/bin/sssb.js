#!/usr/bin/env node
// @ts-check
// THE sssb CLI (ADR-0014, step P4). Every command acts on the app in the working directory, or the one `--app
// <dir>` names, so each package's own scripts work as they are (part 9). Run it as `pnpm exec sssb`, never
// `npx sssb`: outside a package that installs @sssb/tools, npx would fetch an unscoped `sssb` from the registry.
//
// Each command is its own module, loaded only when named, so a command that needs nothing installed (`ci
// e2e-shards`, `port`) runs before `pnpm install` has, and none pays for another's dependencies.
import { UsageError } from '../src/app.js'

/** @type {Record<string, { load: () => Promise<{ run: (args: string[]) => Promise<number> }>, summary: string }>} */
const COMMANDS = {
    port: {
        load: () => import('../src/commands/port.js'),
        summary: "print a port service's port for this checkout (the app's own, with no argument)",
    },
    'launch-json': {
        load: () => import('../src/commands/launch-json.js'),
        summary: "write .claude/launch.json for this checkout's apps and ports",
    },
    'check-demo-size': {
        load: () => import('../src/commands/check-demo-size.js'),
        summary: "fail when the app's static demo (dist-demo/index.html) is over its byte budget",
    },
    'serve-standalone': {
        load: () => import('../src/commands/serve-standalone.js'),
        summary: "serve the app's standalone production build, as the Lambda would",
    },
    'e2e-profile': {
        load: () => import('../src/commands/e2e-profile.js'),
        summary: 'run playwright test and rank where the wall clock went',
    },
    'check-tmpdir-leak': {
        load: () => import('../src/commands/check-tmpdir-leak.js'),
        summary: 'run a test command with a private TMPDIR and fail if a test scratch directory survives',
    },
    'check-real-env': {
        load: () => import('../src/commands/check-real-env.js'),
        summary: "the dev:real preflight: name every cutover item the real adapters' environment still lacks",
    },
    'check-doc-paths': {
        load: () => import('../src/commands/check-doc-paths.js'),
        summary: "fail when a doc in the workspace's doc set cites a path that does not exist",
    },
    guide: {
        load: () => import('../src/commands/guide.js'),
        summary: "copy @sssb/kit's app guide into the repository, stamped with its hash (--check compares)",
    },
    ci: {
        load: () => import('../src/commands/ci.js'),
        summary: "a CI job's logic: e2e-shards, e2e, demo-static",
    },
}

function usage() {
    const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
    return [
        'usage: sssb <command> [--app <dir>] [args...]',
        '',
        ...Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`),
    ].join('\n')
}

const [name, ...args] = process.argv.slice(2)
if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    console.log(usage())
    process.exit(name === undefined ? 1 : 0)
}
const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
if (!command) {
    console.error(`sssb: unknown command "${name}"\n\n${usage()}`)
    process.exit(1)
}
try {
    process.exitCode = await (await command.load()).run(args)
} catch (error) {
    if (error instanceof UsageError) {
        console.error(error.message)
        process.exitCode = 1
    } else throw error
}
