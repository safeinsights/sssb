// @ts-check
// The workspace-level files the generator WRITES rather than copies: every one whose copy in SSSB's repository names
// that repository (its two apps, its framework package, its fixture, its maintainers), so a copy would carry SSSB's
// identity into the adopter's. Each function returns a file's text, laid out as the workspace's own Prettier would.
import { PLACEHOLDER_OWNER, PLACEHOLDER_REPO } from './args.js'
import { formatJson, packageJson } from './json.js'
import { yamlString } from './yaml.js'

/**
 * `pnpm verify`: everything CI runs that can run on a laptop, so a local green is a CI green. SSSB's reusable
 * workflow's jobs (lint, typecheck and the coverage run, each app's fences, doctor and e2e-import check; the contract
 * tests; the e2e suites; the static demo; the synth) and the workspace's own (knip, jscpd). Only the secret scan
 * (gitleaks, a binary CI downloads) is CI's alone. The contract tests run on their own, after the parallel group:
 * embedded Postgres starting under a loaded machine is the one step here that times out.
 */
const VERIFY =
    "concurrently --kill-others-on-fail --group 'pnpm:typecheck' 'pnpm:lint' 'pnpm:test:coverage' 'pnpm:knip' " +
    "'pnpm:jscpd' 'pnpm:check:fences' 'pnpm:sssb:doctor' 'pnpm:check:e2e' 'pnpm:synth' && pnpm test:contract && " +
    'pnpm test:e2e && pnpm build:demo-static && pnpm check:demo-size && pnpm e2e:demo-static'

/**
 * @typedef {{
 *   slug: string,
 *   name: string,
 *   repo: string | null,
 *   owners: string[],
 *   meta: import('./template.js').TemplateMeta,
 *   sssbSpec: (pkg: string) => string,
 *   tarballs: Record<string, string> | null,
 *   workflowRef: string,
 * }} Context
 */

/** @param {Context} c */
const app = (c) => `apps/${c.slug}`

/** @param {Context} c */
const repoOrPlaceholder = (c) => c.repo ?? `${PLACEHOLDER_OWNER}/${PLACEHOLDER_REPO}`

/** @param {Context} c */
export function rootPackageJson(c) {
    const filter = `--filter ${c.slug}`
    // A selector that matches no app fails, rather than running nothing and passing.
    const apps = "--filter './apps/*' --fail-if-no-match"
    return packageJson({
        // Not the slug: a root package named like the app makes `pnpm --filter <slug>` match both, and the root's
        // scripts fan out to every app.
        name: `${c.slug}-workspace`,
        version: '0.1.0',
        private: true,
        type: 'module',
        description: `${c.name}: a multi-tenant web application built on SSSB.`,
        packageManager: c.meta.packageManager,
        engines: c.meta.engines,
        scripts: {
            dev: `pnpm ${filter} dev`,
            tick: `pnpm ${filter} tick`,
            build: `pnpm ${apps} --workspace-concurrency=1 build`,
            start: `pnpm ${filter} start`,
            prepare: 'husky && sssb launch-json',
            typecheck: `pnpm ${apps} typecheck && tsc --noEmit`,
            lint: 'eslint . && prettier --check --log-level warn .',
            'lint:fix': 'eslint --fix . && prettier --write --log-level warn .',
            'test:unit': 'sssb check-tmpdir-leak vitest run',
            'test:coverage': 'sssb check-tmpdir-leak vitest run --coverage',
            'test:contract': 'sssb check-tmpdir-leak vitest run --config vitest.contract.config.ts',
            'test:e2e': `pnpm ${apps} --workspace-concurrency=1 test:e2e`,
            knip: 'knip',
            jscpd: 'jscpd',
            // One run checks every app of the workspace; it starts from an app, because the root takes no @sssb/kit.
            'sssb:doctor': `sssb doctor --app ${app(c)}`,
            // Each app's lint fences as its own config composes them (SSSB's reusable workflow runs this per app).
            'check:fences': `pnpm ${apps} exec sssb check-fences`,
            'check:e2e': `pnpm ${apps} check:e2e`,
            'build:demo-static': `pnpm ${apps} build:demo-static`,
            'check:demo-size': `pnpm ${apps} check:demo-size`,
            'e2e:demo-static': `pnpm ${apps} e2e:demo-static`,
            synth: "pnpm --filter './apps/*/infra' --fail-if-no-match synth",
            verify: VERIFY,
        },
        devDependencies: Object.fromEntries(
            Object.entries({ ...c.meta.ranges, '@sssb/tools': c.sssbSpec('tools') }).sort(([a], [b]) =>
                a.localeCompare(b),
            ),
        ),
        sssb: { apps: [app(c)] },
    })
}

/** @param {Context} c */
export function pnpmWorkspace(c) {
    const lines = [
        'packages:',
        '    - apps/*',
        '    - apps/*/infra',
        '    - packages/*',
        '',
        "# pnpm blocks dependencies' install scripts unless they are approved here: these are the ones the app and SSSB's",
        '# packages bring. Every platform embedded-postgres ships is approved, not only the one you work on: the block is',
        '# silent, and on a platform left out `pnpm test:contract` fails with an error that never mentions it.',
        'allowBuilds:',
        ...Object.entries(c.meta.allowBuilds).map(
            ([pkg, allowed]) => `    ${/^[a-z0-9][a-z0-9._-]*$/.test(pkg) ? pkg : yamlString(pkg)}: ${allowed}`,
        ),
        '',
        '# Each importer of @sssb/kit gets an instance of its own, linked to its own @sssb/app-config, or none (ADR-0014',
        "# part 5). Without it a package that takes the framework and links no seam silently shares an app's; after",
        '# changing it, reinstall from a fresh lockfile. `pnpm exec sssb doctor` checks it.',
        'dedupePeerDependents: false',
    ]
    if (c.meta.minimumReleaseAge !== null) {
        lines.push(
            '',
            "# Supply-chain guard: only install package versions published at least this many minutes ago. SSSB's own",
            "# packages are exempt: SSSB's CI gates their releases, and a fix should not wait out the delay.",
            `minimumReleaseAge: ${c.meta.minimumReleaseAge}`,
            'minimumReleaseAgeExclude:',
            "    - '@sssb/*'",
        )
    }
    if (c.tarballs) {
        lines.push(
            '',
            '# Every @sssb package from its packed tarball (`--sssb <dir>`), including where one SSSB package depends on',
            '# another (@sssb/cdk on @sssb/tools), which would otherwise be looked for in the registry. Remove this block',
            '# when you move to published versions.',
            'overrides:',
            ...Object.entries(c.tarballs).map(([pkg, file]) => `    '@sssb/${pkg}': ${yamlString(`file:${file}`)}`),
        )
    }
    return `${lines.join('\n')}\n`
}

export const GITIGNORE = `# dependencies
node_modules/

# builds
.next/
out/
dist/
build/

# Next's generated ambient types, written by \`next typegen\` (each app's typecheck and build run it first) and
# \`next dev\`, which disagree on its contents
next-env.d.ts

# local data written by the fake adapters (pglite, storage, caught emails)
.data/

# test output
coverage/
playwright-report/
test-results/

# env and secrets: secret values never live in the repository
.env
.env.*
!.env.example

# tooling caches
*.tsbuildinfo
.eslintcache

# the static demo's build output
dist-demo/

# cdk synth output
apps/*/infra/cdk.out/

# machine-local Claude Code settings, and the launch configuration \`sssb launch-json\` writes per checkout
.claude/settings.local.json
.claude/launch.json

# OS
.DS_Store
`

export const PRETTIERIGNORE = `node_modules/
.next/
out/
dist/
build/
coverage/
playwright-report/
test-results/
pnpm-lock.yaml
.data/
**/next-env.d.ts
dist-demo/
apps/*/infra/cdk.out/
`

export const LINT_STAGED = `export default {
    // Every extension ESLint lints: a staged \`.mts\` is linted like a \`.ts\`.
    '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}': ['eslint --fix', 'prettier --write'],
    '*.{json,md,yaml,yml,css}': ['prettier --write'],
}
`

/**
 * The workspace root's own lint config, for what no app's config covers: the root's files and packages/*. Each app's
 * eslint.config.mjs (SSSB's preset) lints that app's files wherever ESLint starts, because ESLint 10 takes each file's
 * nearest config.
 */
export const ROOT_ESLINT = `import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// The workspace root's lint config: the root's own files and packages/*. Each app's files are linted by the app's own
// eslint.config.mjs (SSSB's fences, @sssb/eslint-plugin's preset), wherever ESLint is started: ESLint takes each
// file's nearest config. The raw typescript-eslint configs and an explicit tsconfigRootDir, because
// typescript-eslint's \`configs\` getter records each config file that reads it and its parser refuses to guess
// between two.
export default [
    { ignores: ['**/node_modules/**', '**/.next/**', '**/dist-demo/**', 'coverage/**'] },
    js.configs.recommended,
    ...tseslint.plugin.configs['flat/recommended'],
    {
        languageOptions: {
            parserOptions: { tsconfigRootDir: import.meta.dirname },
            globals: { process: 'readonly', console: 'readonly' },
        },
    },
]
`

export const APP_ESLINT = `import sssb from '@sssb/eslint-plugin'

// SSSB's lint fences for this app (@sssb/eslint-plugin's preset), with this app's own exceptions read from
// lint-exceptions.mjs when it has one. Add your own blocks after the preset's; \`pnpm exec sssb check-fences\` fails
// when one of them switches a fence off.
export default [...(await sssb.configs.app({ root: import.meta.dirname }))]
`

export const ROOT_TSCONFIG = formatJson({
    extends: '@sssb/tools/tsconfig.base.json',
    compilerOptions: { lib: ['dom', 'dom.iterable', 'esnext'], types: ['node'] },
    include: ['*.ts'],
})

/** @param {Context} c */
export function vitestConfig(c) {
    return `import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

/**
 * The workspace's apps. ONE PROJECT PER APP, from SSSB's preset (@sssb/tools/vitest): the framework reads the app's
 * registrations through the bare specifier \`@sssb/app-config/*\`, which one project can resolve for one app only, so
 * each app's project passes its own seam. Each app's conformance suite (src/sssb.conformance.test.ts) runs in its
 * project like any other test; \`pnpm exec sssb doctor\` fails if this config stops running it.
 */
const APPS = ['${c.slug}']

export default defineConfig(async (): Promise<ViteUserConfig> => ({
    test: {
        projects: await Promise.all(APPS.map((app) => appTestProject({ appDir: at(\`./apps/\${app}\`) }))),
        coverage: {
            provider: 'v8',
            include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
            exclude: ['apps/*/src/demo-static/**', '**/*.stories.tsx', '**/*.test.{ts,tsx}'],
            // json-summary: SSSB's reusable workflow puts the totals on the run's page.
            reporter: ['text-summary', 'json-summary'],
        },
    },
}))
`
}

/** @param {Context} c */
export function vitestContractConfig(c) {
    return `import { fileURLToPath } from 'node:url'
import { appTestProject } from '@sssb/tools/vitest'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

const APPS = ['${c.slug}']

/**
 * The contract tests: each app's tests/contract (SSSB's contract runner, @sssb/kit/testing/contract) against real
 * Postgres, a database of the app's own. The preset's project per app, narrowed to tests/contract, in Node, one file at
 * a time, because every app's embedded Postgres takes the one port (CONTRACT_DATABASE_URL names a server instead; CI
 * passes its service container's). The unit config never reaches tests/contract.
 */
const contract = async (app: string) => {
    const project = await appTestProject({ appDir: at(\`./apps/\${app}\`) })
    return { ...project, test: { ...project.test, environment: 'node', include: ['tests/contract/**/*.test.ts'] } }
}

export default defineConfig(async (): Promise<ViteUserConfig> => ({
    test: { fileParallelism: false, projects: await Promise.all(APPS.map(contract)) },
}))
`
}

/** @param {Context} c */
export function knipJson(c) {
    return formatJson({
        $schema: 'https://unpkg.com/knip@6/schema.json',
        workspaces: {
            '.': {
                // knip's Vitest plugin reads vitest.config.ts only.
                entry: ['vitest.contract.config.ts'],
                // @sssb/cdk bundles the app's migrator with the workspace root's esbuild at synth.
                ignoreDependencies: ['esbuild'],
            },
            [app(c)]: {
                // The seam is read by SSSB's framework, the module that names it, never by the app's own code.
                entry: ['src/demo-static/**/*.{ts,tsx}', 'src/app-config/**/*.ts', 'src/seed/*.ts'],
                project: ['src/**'],
                // The seam link (@sssb/kit resolves it), and the tools SSSB's presets load from the app's directory
                // (@sssb/tools/vite and /vitest), none of which the app imports.
                ignoreDependencies: ['@sssb/app-config', '@vitejs/plugin-react', 'vite-plugin-singlefile'],
            },
        },
    })
}

export const JSCPD = formatJson({
    pattern: '{apps/*/src,packages/*/src}/**/*.{ts,tsx}',
    ignore: ['**/*.test.{ts,tsx}', '**/*.stories.tsx'],
    minTokens: 70,
    minLines: 8,
    threshold: 2,
    reporters: ['consoleFull'],
    gitignore: true,
})

export const GITLEAKS = `# gitleaks' default rules (the secret-scan job in .github/workflows/checks.yml). Add an allowlist entry only with a
# justification, scoped to one file AND one string (\`condition = "AND"\`), so a real leak elsewhere is still caught.
[extend]
useDefault = true
`

/** @param {Context} c */
export function codeowners(c) {
    if (c.owners.length === 0) {
        return `# Who reviews what. @${PLACEHOLDER_OWNER} is not a real account: replace it with the GitHub user or team who
# should review changes here before you turn on "require review from Code Owners". With an owner GitHub does not
# know, that setting makes every pull request unmergeable.
*   @${PLACEHOLDER_OWNER}
`
    }
    return `# Who reviews what: every change, by default. Narrow it with path entries below as the workspace grows.
*   ${c.owners.join(' ')}
`
}

/** @param {Context} c */
export function securityMd(c) {
    return `# Security policy

## Reporting a vulnerability

Report privately through **[GitHub Security Advisories](https://github.com/${repoOrPlaceholder(c)}/security/advisories/new)**.
Please do not open a public issue for a vulnerability.

Include what you did, what happened, and what you expected. A failing test or a \`curl\` is worth more than a
paragraph.

## Built on SSSB

This app, ${c.name}, is built on SSSB's packages (\`@sssb/*\`). If the root cause is a shape SSSB gave it (tenant
isolation, authorization, the fail-closed production guard), please report it to SSSB as well, through the security
policy of the repository its packages name in their \`package.json\`: every app built on SSSB has the same shape.
`
}

/** @param {Context} c */
export function codeOfConduct(c) {
    return `# Code of conduct

## The short version

Be decent. Assume good faith. Argue about the code, not the person.

## Our pledge

We pledge to make participation in this project a harassment-free experience for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender identity and expression, level of
experience, education, socio-economic status, nationality, personal appearance, race, religion, or sexual identity
and orientation.

## Enforcement

Report unacceptable behaviour through
**[GitHub Security Advisories](https://github.com/${repoOrPlaceholder(c)}/security/advisories/new)**, a public
repository's private inbound channel. All complaints will be reviewed and investigated promptly and fairly, and the
reporter's privacy will be respected.

## Attribution

Adapted from the [Contributor Covenant](https://www.contributor-covenant.org), version 2.1.
`
}

/** @param {Context} c */
export function issueConfig(c) {
    return `blank_issues_enabled: true
contact_links:
    - name: Security vulnerability
      url: https://github.com/${repoOrPlaceholder(c)}/security/advisories/new
      about: Report privately through GitHub Security Advisories, not a public issue. See SECURITY.md.
`
}

export const BUG_REPORT = `name: Bug report
description: Something behaves differently than it should
labels: [bug]
body:
    - type: textarea
      id: what
      attributes:
          label: What happened
          description: What you did, what happened, what you expected instead.
      validations:
          required: true
    - type: textarea
      id: repro
      attributes:
          label: How to reproduce
          description: Commands or steps. A failing test is worth more than a description.
      validations:
          required: true
`

/** @param {Context} c */
export function workflow(c) {
    return `# This workspace's checks. SSSB's checks for the app are SSSB's REUSABLE WORKFLOW, called here pinned to a commit
# of SSSB's repository (a tag can be moved; a commit cannot). Require the check \`sssb / all-checks\` in your branch
# protection or ruleset: it fails unless every one of SSSB's jobs ran and passed, so a skipped or renamed job cannot
# slip out of the requirement. Raise the pin when you upgrade the @sssb packages (the release notes name the commit).
#
# The reusable workflow takes no secrets: never pass it \`secrets: inherit\`. If this repository is private and in an
# organization, the organization must allow public reusable workflows in its Actions settings.
name: checks

on:
    push:
        branches: [main]
    pull_request:

# Least privilege: nothing by default, and each job states its own.
permissions: {}

concurrency:
    group: checks-\${{ github.event_name == 'push' && github.sha || github.ref }}
    cancel-in-progress: true

jobs:
    # Lint, typecheck and unit tests with SSSB's fence, doctor and e2e-import checks, the contract tests on real
    # Postgres, the e2e shards, the static demo, the CDK synth, and \`all-checks\`. Its checks are named \`sssb / <job>\`.
    sssb:
        uses: ${c.meta.workflow.repository}/.github/workflows/app-checks.yml@${c.workflowRef} # @sssb/create ${c.meta.version}
        permissions:
            contents: read
        with:
            synth: ./${app(c)}/infra

    # What SSSB's workflow does not run: dead code (knip) and duplication (jscpd).
    workspace-checks:
        runs-on: ubuntu-latest
        permissions:
            contents: read
        steps:
            - uses: ${c.meta.actions['actions/checkout']}
            - uses: ${c.meta.actions['pnpm/action-setup']}
            - uses: ${c.meta.actions['actions/setup-node']}
              with:
                  node-version-file: .nvmrc
                  cache: pnpm
            - run: pnpm install --frozen-lockfile
            - run: pnpm knip
            - run: pnpm jscpd

    # Secret scanning over the whole history, with this repository's own .gitleaks.toml.
    secret-scan:
        runs-on: ubuntu-latest
        permissions:
            contents: read
        steps:
            - uses: ${c.meta.actions['actions/checkout']}
              with:
                  fetch-depth: 0 # full history: a secret committed then deleted is still leaked
            - name: gitleaks (pinned binary; gitleaks-action requires a license key for organization repositories)
              run: |
                  curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v${c.meta.gitleaksVersion}/gitleaks_${c.meta.gitleaksVersion}_linux_x64.tar.gz | tar -xz gitleaks
                  ./gitleaks git --redact --config .gitleaks.toml
`
}

/** The Claude Code release that first takes a commit SHA as a GitHub marketplace's `ref`. */
const CLAUDE_CODE_FLOOR = '2.1.324'

/**
 * The project's Claude Code settings (ADR-0014 part 9): SSSB's plugin marketplace, pinned to the same commit of SSSB's
 * repository as the reusable workflow (a plugin runs on developers' machines, with more reach than CI), and SSSB's plugin
 * enabled from it. `pnpm exec sssb doctor` reports when the pin differs from the installed @sssb/kit's release commit.
 * @param {Context} c
 */
export function claudeSettings(c) {
    const { marketplace, name } = c.meta.plugin
    return formatJson({
        extraKnownMarketplaces: {
            [marketplace]: { source: { source: 'github', repo: c.meta.workflow.repository, ref: c.workflowRef } },
        },
        enabledPlugins: { [`${name}@${marketplace}`]: true },
    })
}

/**
 * The workspace's own agent guide, which imports SSSB's app guide (the stamped copy `sssb guide` keeps). Written once:
 * it is the adopter's from then on, and the rules below the import are theirs.
 */
export const CLAUDE_MD = `# Agent guide

SSSB's app guide, the rules every app on SSSB follows, from the copy \`pnpm exec sssb guide\` keeps (after an upgrade,
\`pnpm exec sssb doctor\` fails until it is refreshed):

@.claude/sssb-guide.md

## This workspace

Your own rules go here: what the app is for, its domain's vocabulary, and the conventions your team keeps.
`

/** @param {Context} c */
export function cutoverChecklist(c) {
    return `# Cutover checklist

Everything ${c.name} defers because it needs real credentials, accounts or money. The app boots and is fully testable
without any of it: nothing here is a blocker, each is a row. Fill in who unlocks each one and the proof it owes (a
real send through the email port, not "set up email"), and add rows as the app acquires dependencies. A real adapter
is authored but unverified until its row closes.

These are SSSB's rows, the ones every app on SSSB has; \`pnpm exec sssb doctor\` reports one this file stops
mentioning. \`config/params.ts\` in each app names the row that fills each placeholder.

${c.meta.cutoverRows.map((row) => `- [ ] \`${row.id}\`: ${row.what}`).join('\n')}
`
}

/** @param {number} budget the app's demo-size budget, in bytes */
export function demoSizeMd(budget) {
    return `# Demo size budget

The static demo (\`pnpm build:demo-static\`) is one HTML file you can hand someone, and \`pnpm check:demo-size\`
fails if it grows past a byte budget. The number is the argument of \`check:demo-size\` in this app's
\`package.json\` (${budget} bytes when it was generated), and it is this app's own: the command, \`sssb check-demo-size\`
(from \`@sssb/tools\`), holds no number, and says what to look at first when the gate goes red.

It starts roomy, sized for an app's own screens and not as a pacing gate. If you want a pacing gate, set it to what
your app measures plus the headroom you want.

## How to change it

Re-set the number in \`package.json\` and add an entry under "Changes" below in the same commit: what grew or shrank,
by how much, and how much headroom you left on purpose. Newest first.

## Changes

None yet.
`
}

/** @param {Context} c */
export function readme(c) {
    return `# ${c.name}

A multi-tenant web application built on SSSB: Next.js, ports and adapters, row-level-security tenancy, and a
hermetic local world. Generated by \`@sssb/create\` ${c.meta.version}.

## Start

\`\`\`sh
git init
pnpm install
pnpm exec playwright install chromium   # once, for the e2e suites
pnpm dev                                # the app, seeded, offline, no credentials
pnpm verify                             # what CI runs, but the secret scan
\`\`\`

\`pnpm verify\` runs what this workspace's CI runs, so a green here is a green there: typecheck, lint, the unit tests
with coverage, knip, jscpd, the lint fences, doctor, the contract tests on real Postgres (an embedded server locally),
the e2e suites, the static demo and the offline CDK synth. Only the secret scan (gitleaks) is CI's alone.

## Layout

- \`${app(c)}/\`: the app. Its \`src/app-config/\` is the seam SSSB's framework (\`@sssb/kit\`) reads the app's
  registrations through, linked as the package \`@sssb/app-config\`; \`config/app.ts\` holds its slug and
  \`config/params.ts\` its deployment parameters.
- \`${app(c)}/infra/\`: the app's deployment, a CDK app composing SSSB's \`SssbApp\` construct (\`@sssb/cdk\`).
- \`docs/cutover-checklist.md\`: what the app defers until it has real accounts.
- \`.claude/sssb-guide.md\`: SSSB's app guide (the rules an app on SSSB follows), a stamped copy of the one
  \`@sssb/kit\` ships, which \`CLAUDE.md\` imports (\`@.claude/sssb-guide.md\`; keep that line when you make the file
  your own). After an upgrade, \`pnpm exec sssb guide\` refreshes it; \`pnpm exec sssb doctor\` fails until you do, so
  the change reaches your diff.
- \`.claude/settings.json\`: SSSB's Claude Code plugin, enabled (below).
- The root: the workspace's config on SSSB's presets (\`@sssb/tools\`, \`@sssb/eslint-plugin\`).

## Claude Code

\`.claude/settings.json\` declares SSSB's plugin marketplace (\`${c.meta.plugin.marketplace}\`), pinned to the same commit
of SSSB's repository as the CI workflow, and enables its plugin, \`${c.meta.plugin.name}@${c.meta.plugin.marketplace}\`:
the commands an app author runs, namespaced as \`/${c.meta.plugin.name}:<command>\` (\`/${c.meta.plugin.name}:new-entity\`,
\`/${c.meta.plugin.name}:verify\` and the rest), and the \`doc-steward\` agent.

- **Claude Code ${CLAUDE_CODE_FLOOR} or later**: older versions cannot pin a marketplace to a commit
  (\`claude --version\`; \`claude update\`).
- **Install the plugin once per clone**, after trusting the folder (enabling it does not install it):
  \`claude plugin install ${c.meta.plugin.name}@${c.meta.plugin.marketplace} --scope project\`.
- **Raise the marketplace's \`ref\` with the workflow's pin** when you upgrade (below).

## CI, and the settings only you can make

\`.github/workflows/checks.yml\` calls SSSB's reusable workflow, pinned to a commit of SSSB's repository (its \`sssb\`
job's \`uses:\` line), beside this workspace's own knip, jscpd and secret-scan jobs. On GitHub:

- **Require the check \`sssb / all-checks\`** in a ruleset or branch protection on your default branch. It fails unless
  every one of SSSB's jobs ran and passed. Require \`workspace-checks\` and \`secret-scan\` too.
- If the repository is private and in an organization, allow public reusable workflows in the organization's Actions
  settings.
- Turn on private vulnerability reporting, which \`SECURITY.md\` and \`CODE_OF_CONDUCT.md\` point reporters to.
${
    c.repo === null || c.owners.length === 0
        ? `- Replace the placeholders the generator left (\`${PLACEHOLDER_OWNER}\`, \`${PLACEHOLDER_REPO}\`) in
  \`CODEOWNERS\`, \`SECURITY.md\`, \`CODE_OF_CONDUCT.md\` and \`.github/ISSUE_TEMPLATE/config.yml\`.\n`
        : ''
}- Add a \`LICENSE\` of your choice.
- The workflow runs on pushes to \`main\`; rename the branch there if yours differs.

## Upgrading SSSB

The \`@sssb/*\` packages are released together at one version: move them together, read the release notes'
"Seam changes", "Framework migrations", "Operator actions" and "Scaffold changes to apply by hand", and raise the
workflow's pin and the plugin marketplace's \`ref\` in \`.claude/settings.json\` to the commit the notes name.
\`pnpm exec sssb doctor\` fails when the installed packages are out of step, and reports a pin that is not the release
commit the installed \`@sssb/kit\` names.
`
}
