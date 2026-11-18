/**
 * The ruleset changes that make the release app the ONLY bypass on `main` and on the release tags, and
 * nothing wider. Pure: `planBypass` takes the repository's rulesets as GitHub reports them and returns the
 * changes, which the CLI prints and (only with `--apply`) makes.
 *
 * WHY THERE ARE FOUR RULESETS AND NOT TWO. A bypass actor bypasses EVERY rule in its ruleset, never one
 * rule. So adding the App to a ruleset that also forbids deleting or moving refs would let it delete or
 * move them, which release.yml never needs. The rules the App must pass are therefore kept apart from the
 * rules nobody may pass:
 *   - `main: required checks` — required status checks; the App bypasses (its release commit is checked
 *     after the push, by release.yml's `pack` job, before anything publishes).
 *   - `main: history` — deletion and non-fast-forward on `main`, NO bypass. Needed because the App must also
 *     bypass the ORGANIZATION ruleset `require-pr` (its pull_request rule blocks any direct push), and that
 *     ruleset carries deletion and non-fast-forward too. This one keeps them closed to the App.
 *   - `release tags: v*` — creation only; the App bypasses, so only it creates a `v*` tag.
 *   - `release tags: v* immutable` — update, deletion and non-fast-forward on `v*`, NO bypass, so nobody,
 *     the App included, moves or deletes a release tag.
 * The organisation ruleset is not this tool's to change: it is shared by every repository in the org and
 * needs `admin:org`. The CLI prints that step for JP; `orgRulesetsToBypass` says which ones.
 */
import { RELEASE_REPO } from './manifest'

export const MAIN_CHECKS = 'main: required checks'
export const MAIN_HISTORY = 'main: history'
export const TAGS_CREATE = 'release tags: v*'
export const TAGS_IMMUTABLE = 'release tags: v* immutable'

const DEFAULT_BRANCH = '~DEFAULT_BRANCH'
const RELEASE_TAGS = 'refs/tags/v*'

type Rule = { type: string; parameters?: unknown }
export type BypassActor = { actor_id: number | null; actor_type: string; bypass_mode: string }
type RulesetBody = {
    name: string
    target: 'branch' | 'tag'
    enforcement: string
    conditions: { ref_name: { include: string[]; exclude: string[] } }
    rules: Rule[]
    bypass_actors: BypassActor[]
}
/** A ruleset as `GET /repos/{o}/{r}/rulesets/{id}` returns it, narrowed to what this reads. */
export type Ruleset = RulesetBody & { id: number; source_type: string }

export type RulesetChange =
    { kind: 'create'; body: RulesetBody } | { kind: 'update'; id: number; before: RulesetBody; after: RulesetBody }

export type BypassPlan = { changes: RulesetChange[]; problems: string[] }

/** The App as a bypass actor: `always`, so its direct push passes; GitHub's audit log records each bypass. */
function appBypass(appId: number): BypassActor {
    return { actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }
}

const TAG_RULE_TYPES = new Set(['creation', 'update', 'deletion', 'non_fast_forward'])

function body(ruleset: RulesetBody): RulesetBody {
    return {
        name: ruleset.name,
        target: ruleset.target,
        enforcement: ruleset.enforcement,
        conditions: {
            ref_name: {
                include: [...(ruleset.conditions?.ref_name?.include ?? [])],
                exclude: [...(ruleset.conditions?.ref_name?.exclude ?? [])],
            },
        },
        rules: (ruleset.rules ?? []).map((rule) =>
            rule.parameters === undefined ? { type: rule.type } : { type: rule.type, parameters: rule.parameters },
        ),
        bypass_actors: (ruleset.bypass_actors ?? []).map((actor) => ({
            actor_id: actor.actor_id,
            actor_type: actor.actor_type,
            bypass_mode: actor.bypass_mode,
        })),
    }
}

/** A stable rendering for comparison: rules are compared as a set, by type then parameters. */
function canonical(ruleset: RulesetBody): string {
    const b = body(ruleset)
    const rules = b.rules.map((rule) => JSON.stringify(rule)).sort()
    const actors = b.bypass_actors.map((actor) => JSON.stringify(actor)).sort()
    return JSON.stringify({ ...b, rules, bypass_actors: actors })
}

function simple(name: string, target: 'branch' | 'tag', include: string, types: string[], bypass: BypassActor[]) {
    return {
        name,
        target,
        enforcement: 'active',
        conditions: { ref_name: { include: [include], exclude: [] } },
        rules: types.map((type) => ({ type })),
        bypass_actors: bypass,
    } satisfies RulesetBody
}

/**
 * The changes that bring the repository's own rulesets to the shape described at the top of this file.
 * Creates come first, so the rulesets with no bypass exist before any bypass is granted or any rule is
 * moved out of an existing ruleset: at no point is a ref less protected than before. Anything this cannot
 * read safely is a problem, and a plan with problems must not be applied.
 */
export function planBypass(rulesets: Ruleset[], appId: number): BypassPlan {
    const problems: string[] = []
    if (!Number.isInteger(appId) || appId <= 0) {
        return { changes: [], problems: [`the App id must be a positive integer, got ${appId}`] }
    }
    const own = rulesets.filter((ruleset) => ruleset.source_type === 'Repository')
    const byName = (name: string): Ruleset | undefined => {
        const found = own.filter((ruleset) => ruleset.name === name)
        if (found.length > 1) problems.push(`${found.length} repository rulesets are named "${name}"; expected one`)
        return found[0]
    }
    const bypass = [appBypass(appId)]
    const creates: RulesetChange[] = []
    const updates: RulesetChange[] = []

    const want = (current: Ruleset | undefined, desired: RulesetBody, target: RulesetChange[]) => {
        if (!current) target.push({ kind: 'create', body: desired })
        else if (canonical(current) !== canonical(desired))
            target.push({ kind: 'update', id: current.id, before: body(current), after: desired })
    }

    const checks = byName(MAIN_CHECKS)
    if (!checks) {
        problems.push(`no repository ruleset named "${MAIN_CHECKS}"; it holds main's required checks`)
    } else if (checks.target !== 'branch') {
        problems.push(`"${MAIN_CHECKS}" targets ${checks.target}, not branch`)
    } else {
        const include = checks.conditions?.ref_name?.include ?? []
        if (!include.includes(DEFAULT_BRANCH) && !include.includes('refs/heads/main')) {
            problems.push(`"${MAIN_CHECKS}" does not cover main (its include is ${JSON.stringify(include)})`)
        }
        // Only the bypass list and enforcement change; its rules are the checks and stay as they are.
        want(checks, { ...body(checks), enforcement: 'active', bypass_actors: bypass }, updates)
    }

    want(
        byName(MAIN_HISTORY),
        simple(MAIN_HISTORY, 'branch', DEFAULT_BRANCH, ['deletion', 'non_fast_forward'], []),
        creates,
    )

    const tags = byName(TAGS_CREATE)
    if (!tags) {
        problems.push(`no repository ruleset named "${TAGS_CREATE}"`)
    } else {
        if (tags.target !== 'tag') problems.push(`"${TAGS_CREATE}" targets ${tags.target}, not tag`)
        const include = tags.conditions?.ref_name?.include ?? []
        if (include.length !== 1 || include[0] !== RELEASE_TAGS) {
            problems.push(`"${TAGS_CREATE}" covers ${JSON.stringify(include)}; expected exactly ["${RELEASE_TAGS}"]`)
        }
        const unknown = (tags.rules ?? []).map((rule) => rule.type).filter((type) => !TAG_RULE_TYPES.has(type))
        if (unknown.length > 0) {
            problems.push(
                `"${TAGS_CREATE}" carries rules this tool would drop (${unknown.join(', ')}); move them by hand first`,
            )
        }
        want(tags, simple(TAGS_CREATE, 'tag', RELEASE_TAGS, ['creation'], bypass), updates)
    }

    want(
        byName(TAGS_IMMUTABLE),
        simple(TAGS_IMMUTABLE, 'tag', RELEASE_TAGS, ['update', 'deletion', 'non_fast_forward'], []),
        creates,
    )

    return { changes: problems.length > 0 ? [] : [...creates, ...updates], problems }
}

/** One rule as `GET /repos/{o}/{r}/rules/branches/{branch}` returns it. */
export type ActiveRule = { type: string; ruleset_source_type: string; ruleset_source: string; ruleset_id: number }

/**
 * The organisation rulesets that would refuse the App's push to `main`, and whether each already lists the
 * App as a bypass. Every org ruleset with a rule on `main` is listed: deletion and non-fast-forward alone
 * would not stop a plain push, but this does not try to judge which rule types a given org ruleset carries
 * now and later. `bypassOf` reads a ruleset's bypass list (null when it cannot).
 */
export function orgRulesetsToBypass(
    activeOnMain: ActiveRule[],
    bypassOf: Map<number, BypassActor[] | null>,
    appId: number,
): { id: number; source: string; types: string[]; hasApp: boolean | null }[] {
    const byId = new Map<number, { id: number; source: string; types: string[] }>()
    for (const rule of activeOnMain) {
        if (rule.ruleset_source_type !== 'Organization') continue
        const entry = byId.get(rule.ruleset_id) ?? { id: rule.ruleset_id, source: rule.ruleset_source, types: [] }
        entry.types.push(rule.type)
        byId.set(rule.ruleset_id, entry)
    }
    return [...byId.values()].map((entry) => {
        const actors = bypassOf.get(entry.id)
        const hasApp =
            actors === undefined || actors === null
                ? null
                : actors.some((actor) => actor.actor_type === 'Integration' && actor.actor_id === appId)
        return { ...entry, hasApp }
    })
}

/** A readable rendering of one change, for the terminal. */
export function describeChange(change: RulesetChange): string {
    const repo = `${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`
    if (change.kind === 'create') {
        return [
            `CREATE ruleset "${change.body.name}" on ${repo}`,
            `  gh api -X POST repos/${repo}/rulesets --input -   with:`,
            indent(JSON.stringify(change.body, null, 2), 4),
        ].join('\n')
    }
    const lines = [`UPDATE ruleset "${change.before.name}" (id ${change.id}) on ${repo}`]
    for (const key of ['enforcement', 'rules', 'bypass_actors', 'conditions'] as const) {
        const before = JSON.stringify(change.before[key])
        const after = JSON.stringify(change.after[key])
        if (before !== after) lines.push(`  ${key}:`, `    - ${before}`, `    + ${after}`)
    }
    lines.push(`  gh api -X PUT repos/${repo}/rulesets/${change.id} --input -   with:`)
    lines.push(indent(JSON.stringify(change.after, null, 2), 4))
    return lines.join('\n')
}

function indent(text: string, by: number): string {
    return text
        .split('\n')
        .map((line) => ' '.repeat(by) + line)
        .join('\n')
}
