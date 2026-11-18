/**
 * What the release app is called, what it may do, and the read-back check `verify` runs against its
 * installation. Pure, so tests/tooling/release-app.test.ts covers it without a live App. Borrowed from
 * CanopyCMS's `src/cli/github-app-manifest.ts`; the differences are SSSB's own (one fixed repository, a
 * key that goes to an Actions environment, and the token's single job in release.yml).
 */

/** The one repository this App exists for. It is never installed anywhere else. */
export const RELEASE_REPO = { owner: 'safeinsights', repo: 'sssb' } as const

/** The environment release.yml's `push` job runs in, and the names it reads the App by. */
export const RELEASE_ENVIRONMENT = 'release'
export const KEY_SECRET = 'RELEASE_BOT_PRIVATE_KEY'
/** A VARIABLE, not a secret: release.yml reads `vars.RELEASE_BOT_CLIENT_ID`, and a client id is not secret. */
export const CLIENT_ID_VARIABLE = 'RELEASE_BOT_CLIENT_ID'

/** Permission levels GitHub uses for App repository permissions, weakest first. */
const PERMISSION_LEVELS = ['read', 'write', 'admin'] as const
type PermissionLevel = (typeof PERMISSION_LEVELS)[number]
export type PermissionSet = Readonly<Record<string, PermissionLevel>>

/**
 * The App's entire security surface. Each entry names what in release.yml forces it, and
 * tests/tooling/release-app-drift.test.ts reads release.yml to keep it so, in both directions.
 * - `contents: write`: the `push` job's one `git push`, which lands the release commit on `main` and
 *   creates its `vX.Y.Z` tag. GitHub's permissions reference puts git pushes under Contents/write.
 * - `metadata: read`: implied by any repository permission; declared so this object states the whole
 *   surface, not just the part that is not automatic.
 * Nothing else. No `workflows`: a release commit that touched `.github/workflows/` is refused by GitHub for
 * lack of it, which is a lock we want (scripts/release.mjs verify-release refuses it first). No `actions`,
 * `checks`, `pull_requests` or `administration`: the CI gate reads runs with the job's own GITHUB_TOKEN,
 * and the App never opens a PR, edits a setting or touches a ruleset. Bypassing a ruleset needs no
 * permission at all: it is the ruleset's bypass list that names the App.
 */
export const RELEASE_APP_PERMISSIONS: PermissionSet = {
    contents: 'write',
    metadata: 'read',
}

/**
 * GitHub's limit on an App's display name: documented as unlimited, but CanopyCMS saw a 39-character name
 * refused while 33 was accepted, so the bound is 33..38, and 34 is the safe direction.
 */
export const APP_NAME_MAX_LENGTH = 34

/** The default display name. Names are unique across all of GitHub, so `--name` overrides it. */
export const DEFAULT_APP_NAME = 'SafeInsights SSSB release'

/**
 * GitHub's slug derivation, as far as this needs it: lowercase, runs of non-alphanumerics collapse to one
 * hyphen. If GitHub ever derives differently, the name pre-check goes blind, not loud.
 */
export function appSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}

/**
 * A summary short enough to survive the account's App list (it truncates at about 37 characters), then the
 * detail only the App's own page shows. Generic on purpose: this text lives on GitHub and goes stale there.
 */
export function appDescription(): string {
    return [
        'Pushes SSSB release commits and tags',
        '',
        "Used only by release.yml's push job, from the `release` environment, to push the release commit " +
            'to main and its vX.Y.Z tag. Installed on safeinsights/sssb only; it is the only bypass on the ' +
            'rulesets for main and the release tags.',
    ].join('\n')
}

/**
 * Where the manifest form posts. `state` rides on the ACTION URL: GitHub echoes it back on the redirect, and
 * inside the manifest JSON it would look implemented while protecting nothing.
 */
export function manifestPostUrl(state: string): string {
    return (
        `https://github.com/organizations/${encodeURIComponent(RELEASE_REPO.owner)}/settings/apps/new` +
        `?state=${encodeURIComponent(state)}`
    )
}

/**
 * The App as GitHub's manifest flow takes it. Private, no webhook (declared inactive, as the flow requires
 * the block), no events, no OAuth on install, and `default_permissions` is the whole surface.
 */
export function appManifest(redirectUrl: string, name = DEFAULT_APP_NAME): Record<string, unknown> {
    return {
        name,
        url: `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`,
        description: appDescription(),
        public: false,
        redirect_url: redirectUrl,
        hook_attributes: { url: 'https://example.invalid/unused', active: false },
        default_events: [],
        default_permissions: { ...RELEASE_APP_PERMISSIONS },
        request_oauth_on_install: false,
        setup_on_update: false,
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * The auto-submitting form that carries the manifest to GitHub: a manifest can only be delivered as a
 * browser form POST. Both interpolations are escaped, since `--name` lands in a file a browser executes.
 */
export function creationForm(target: string, manifest: Record<string, unknown>): string {
    return `<!doctype html><meta charset="utf-8"><title>Create the SSSB release app</title>
<body style="font:16px system-ui;padding:3rem" onload="document.forms[0].submit()">
<p>Submitting the App manifest to GitHub…</p>
<form method="post" action="${escapeHtml(target)}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <button type="submit">Create the App</button>
</form>
</body>`
}

/** A small HTML page for the loopback server's answers. */
export function resultPage(title: string, detail: string): string {
    return (
        `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        `<body style="font:16px system-ui;padding:3rem"><h1>${escapeHtml(title)}</h1>` +
        `<p>${escapeHtml(detail)}</p></body>`
    )
}

/** The parts of GitHub's installation object this tool reads back. */
export type InstallationSummary = {
    id: number
    permissions?: Record<string, string>
    repository_selection?: string
    suspended_at?: string | null
    account?: { login?: string }
}

function isPermissionLevel(value: string): value is PermissionLevel {
    return (PERMISSION_LEVELS as readonly string[]).includes(value)
}

/**
 * Compare a set of permissions GitHub reports (an installation's, or the App's own) with what release.yml
 * needs. Exact match is the only pass, in BOTH directions: an extra or over-wide permission works perfectly
 * and is never noticed by anything else.
 */
export function permissionFindings(
    held: Record<string, string>,
    desired: PermissionSet = RELEASE_APP_PERMISSIONS,
): string[] {
    const findings: string[] = []
    for (const [name, level] of Object.entries(desired)) {
        const actual = held[name]
        if (actual === undefined) findings.push(`missing permission ${name}: ${level}`)
        else if (actual === level) continue
        else if (!isPermissionLevel(actual))
            findings.push(`permission ${name} is "${actual}", a level this check does not know; expected "${level}"`)
        else if (PERMISSION_LEVELS.indexOf(actual) < PERMISSION_LEVELS.indexOf(level))
            findings.push(`permission ${name} is "${actual}", weaker than the required "${level}"`)
        else findings.push(`permission ${name} is "${actual}", STRONGER than the required "${level}"`)
    }
    for (const [name, level] of Object.entries(held)) {
        if (desired[name] === undefined) findings.push(`permission ${name}: ${level} is held but NOT needed`)
    }
    return findings
}

/**
 * Everything wrong with an installation, as messages; empty is the pass. `repositories` is what the
 * installation reaches, read with a token minted for it; `null` means it could not be read, which fails
 * rather than passes.
 */
export function installationFindings(installation: InstallationSummary, repositories: string[] | null): string[] {
    const findings: string[] = []
    if (installation.suspended_at) {
        findings.push(
            `the installation is SUSPENDED (since ${installation.suspended_at}); it authenticates and then refuses everything`,
        )
    }
    if (installation.account?.login !== RELEASE_REPO.owner) {
        findings.push(
            `the installation is on ${JSON.stringify(installation.account?.login ?? null)}, not ${RELEASE_REPO.owner}`,
        )
    }
    // `undefined` is NOT `selected`: an absent field means GitHub did not say, and treating that as the
    // narrow case would be the check passing itself.
    if (installation.repository_selection !== 'selected') {
        findings.push(
            `repository_selection is ${JSON.stringify(installation.repository_selection ?? null)}, expected "selected": ` +
                'an installation on every repository puts this key in reach of all of them',
        )
    }
    findings.push(...permissionFindings(installation.permissions ?? {}))
    const expected = `${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`
    if (repositories === null) {
        findings.push('could not list the repositories the installation reaches, so "this repository only" is UNCHECKED')
    } else if (repositories.length !== 1 || repositories[0] !== expected) {
        findings.push(
            `the installation reaches ${JSON.stringify(repositories)}; it must reach ${expected} and nothing else`,
        )
    }
    return findings
}
