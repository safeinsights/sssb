import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

/**
 * A fake `gh` for release.yml's jobs that make a GitHub release (`prerelease` on a candidate's tag, `github-release` on
 * a plain one), each run as GitHub runs it against this stand-in, which keeps the release's state in a file.
 */
export type Release = {
    draft: boolean
    prerelease: boolean
    latest: boolean | null
    assets: Record<string, string>
    title?: string
    notes?: string
}
/** `viewError`: what `gh release view` fails with instead of answering, as an API or network failure would. */
export type State = { tags: string[]; release: Release | null; calls: string[]; viewError?: string }

const WORKFLOW = new URL('../../.github/workflows/release.yml', import.meta.url)

/** The `run:` script of one of release.yml's steps, read from the workflow, so an edit there is what is tested. */
export function workflowStep(job: string, name: string): string {
    const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
        jobs: Record<string, { steps: { name?: string; run?: string }[] }>
    }
    const step = workflow.jobs[job]?.steps.find((s) => s.name === name)
    if (!step?.run) throw new Error(`release.yml has no \`${name}\` step in its ${job} job`)
    return step.run
}

/**
 * A `gh` that answers only the calls the jobs make, from a state file, and fails on anything else. `--jq` is handed to
 * the real jq with `-r`, as gh prints strings raw. A boolean flag is read as gh reads it: `--x` and `--x=true` set it,
 * `--x=false` clears it.
 */
const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const file = process.env.FAKE_GH_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args.join(' '))
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const flag = (name) => args.includes(name) || args.includes(name + '=true') ? true : args.includes(name + '=false') ? false : undefined
const die = (msg) => { save(); process.stderr.write(msg + '\\n'); process.exit(1) }
if (args[0] !== 'release') die('unexpected gh ' + args.join(' '))
const [, cmd, tag] = args
if (opt('--repo') !== 'safeinsights/sssb') die('wrong repo')
const r = state.release
const dir = process.env.FAKE_GH_ASSETS
if (cmd === 'view') {
  if (state.viewError) die(state.viewError)
  if (!r) die('release not found')
  const all = { isDraft: r.draft, isPrerelease: r.prerelease, tagName: tag, assets: Object.keys(r.assets).map((name) => ({ name })) }
  const fields = opt('--json').split(',')
  const out = JSON.stringify(Object.fromEntries(fields.map((f) => [f, all[f]])))
  const jq = opt('--jq')
  process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: out, encoding: 'utf8' }) : out + '\\n')
} else if (cmd === 'create') {
  if (r) die('a release for ' + tag + ' exists')
  if (!state.tags.includes(tag)) die('tag ' + tag + ' does not exist')
  state.release = { draft: flag('--draft') === true, prerelease: flag('--prerelease') === true, latest: null, assets: {}, title: opt('--title'), notes: fs.readFileSync(opt('--notes-file'), 'utf8') }
} else if (cmd === 'upload') {
  if (!r) die('release not found')
  for (const f of args.slice(3).filter((a) => !a.startsWith('--') && a !== opt('--repo'))) {
    const name = path.basename(f)
    if (r.assets[name] && !args.includes('--clobber')) die('asset ' + name + ' exists')
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(f, path.join(dir, name))
    r.assets[name] = path.join(dir, name)
  }
} else if (cmd === 'download') {
  if (!r) die('release not found')
  if (Object.keys(r.assets).length === 0) die('no assets to download')
  const to = opt('--dir')
  fs.mkdirSync(to, { recursive: true })
  for (const [name, from] of Object.entries(r.assets)) fs.copyFileSync(from, path.join(to, name))
} else if (cmd === 'edit') {
  if (!r) die('release not found')
  if (opt('--title') !== undefined) r.title = opt('--title')
  if (opt('--notes-file') !== undefined) r.notes = fs.readFileSync(opt('--notes-file'), 'utf8')
  if (flag('--draft') !== undefined) r.draft = flag('--draft')
  if (flag('--prerelease') !== undefined) r.prerelease = flag('--prerelease')
  if (flag('--latest') !== undefined) r.latest = flag('--latest')
} else die('unexpected gh release ' + cmd)
save()
`

/**
 * Runs a step's script as GitHub runs it (`bash --noprofile --norc -eo pipefail`) in a runner whose temp directory is
 * `temp`, with the fake `gh` first on PATH, and returns what it printed and the fake's state after it.
 */
export function runStep(temp: string, script: string, state: State, version: string) {
    const stateFile = path.join(temp, 'gh-state.json')
    writeFileSync(stateFile, JSON.stringify(state))
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: {
            NODE_ENV: 'test',
            PATH: `${path.join(temp, 'bin')}:${process.env['PATH']}`,
            RUNNER_TEMP: temp,
            GITHUB_REPOSITORY: 'safeinsights/sssb',
            GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
            GH_TOKEN: 'fake',
            VERSION: version,
            FAKE_GH_STATE: stateFile,
            FAKE_GH_ASSETS: path.join(temp, 'release-assets'),
        },
    })
    return { ...result, state: JSON.parse(readFileSync(stateFile, 'utf8')) as State }
}

/** Puts the fake `gh` in `<temp>/bin`, for `runStep`'s PATH. */
export function installFakeGh(temp: string): void {
    const bin = path.join(temp, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'gh'), FAKE_GH)
    chmodSync(path.join(bin, 'gh'), 0o755)
}

/** A release already holding these files (name → contents), as a draft or published, in the fake's asset store. */
export function existingRelease(
    temp: string,
    files: Record<string, string>,
    { draft, prerelease }: { draft: boolean; prerelease: boolean },
): Release {
    const dir = path.join(temp, 'release-assets')
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
    return {
        draft,
        prerelease,
        latest: draft ? null : !prerelease,
        assets: Object.fromEntries(Object.keys(files).map((n) => [n, path.join(dir, n)])),
    }
}
