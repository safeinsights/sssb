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
 * needs `admin:org`. The CLI prints that step for JP; `externalGates` says which ones, and finds any other
 * ruleset the release's push would meet.
 */
import { RELEASE_REPO } from './manifest'

export const MAIN_CHECKS = 'main: required checks'
export const MAIN_HISTORY = 'main: history'
export const TAGS_CREATE = 'release tags: v*'
export const TAGS_IMMUTABLE = 'release tags: v* immutable'

const DEFAULT_BRANCH = '~DEFAULT_BRANCH'
const RELEASE_TAGS = 'refs/tags/v*'

type Rule = { type: string; parameters?: unknown }
type BypassActor = { actor_id: number | null; actor_type: string; bypass_mode: string }

/**
 * A bypass actor on an ORGANISATION ruleset that a person has vouched cannot use it on this repository, so the
 * release app is still, in effect, the only one. Only an App can be vouched for: "cannot reach this repository" is
 * never true of an organisation admin, a team or a role. The API shows part of the claim and not the rest: the
 * organisation's installation list (which `verify` already reads) says whether the App is installed once, on
 * selected repositories, and not suspended, but which repositories are selected needs a token this tool does not
 * have. So the claim is checked in here, by name, with who made it and when; `verify` and `bypass` report it as a ✓
 * with its reason only while the installation list still agrees, and as a ✗ once it does not (the App moved to all
 * repositories, a second installation, or none). It matches one actor on one ruleset exactly (id and ruleset id);
 * anything else that bypasses an organisation ruleset the release meets still fails. Re-vouch, or remove the entry,
 * when the claim stops being true.
 */
export type VouchedBypass = {
    /** The organisation ruleset's id. */
    ruleset: number
    /** GitHub's `actor_type` and `actor_id`: an App, by its App id. */
    actorType: 'Integration'
    actorId: number
    /** What the actor is, for a person reading the report. */
    name: string
    /** Why it cannot reach this repository, in one line. */
    reason: string
    /** Who vouched, and on which date (YYYY-MM-DD). */
    vouchedBy: string
    on: string
}

export const VOUCHED_ORG_BYPASSES: readonly VouchedBypass[] = [
    {
        ruleset: 7484436,
        actorType: 'Integration',
        actorId: 4038189,
        name: 'canopycms-release-bot',
        reason: 'installed on safeinsights/canopycms only, so it cannot push to safeinsights/sssb',
        vouchedBy: 'JP',
        on: '2026-11-18',
    },
]

/** The entry that vouches for `actor` on organisation ruleset `rulesetId`, if one does. */
export function vouchedFor(
    rulesetId: number,
    actor: BypassActor,
    list: readonly VouchedBypass[] = VOUCHED_ORG_BYPASSES,
): VouchedBypass | undefined {
    return list.find(
        (entry) =>
            entry.ruleset === rulesetId && entry.actorType === actor.actor_type && entry.actorId === actor.actor_id,
    )
}
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
        // main ALONE, never "includes main": the App's bypass reaches every ref this ruleset covers. Held exactly, as
        // the tag ruleset is below.
        const { include = [], exclude = [] } = checks.conditions?.ref_name ?? {}
        const mainOnly = include.length === 1 && [DEFAULT_BRANCH, 'refs/heads/main'].includes(include[0]!)
        if (!mainOnly || exclude.length > 0) {
            problems.push(
                `"${MAIN_CHECKS}" must cover main alone: it covers ${JSON.stringify(checks.conditions?.ref_name ?? null)}; ` +
                    `expected include exactly ["${DEFAULT_BRANCH}"] or ["refs/heads/main"], and no exclude`,
            )
        }
        // Only the bypass list and enforcement change; its rules are the checks and stay as they are. Anything
        // else here (a pull-request or signature rule added later) would be bypassed with them, silently.
        const types = (checks.rules ?? []).map((rule) => rule.type)
        if (types.length !== 1 || types[0] !== 'required_status_checks') {
            problems.push(
                `"${MAIN_CHECKS}" carries ${JSON.stringify(types)}; the App would bypass all of it. Expected only ` +
                    'required_status_checks: move the rest to a ruleset the App does not bypass',
            )
        }
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
 * Rule types that cannot refuse the release's push: on `main`, a fast-forward (an `update` rule refuses every
 * push to a branch, so it is not here); on a tag, a creation.
 */
const HARMLESS_ON_MAIN = new Set(['deletion', 'non_fast_forward'])
const HARMLESS_ON_A_NEW_TAG = new Set(['deletion', 'non_fast_forward', 'update'])

/** An organisation ruleset the App's push meets, which only an org owner can change. */
type OrgGate = {
    id: number
    name: string
    types: string[]
    /** `always` or `exempt`: the push passes. `wrong-mode`: listed, but only for pull requests. */
    app: 'listed' | 'missing' | 'wrong-mode'
    /** Every other bypass actor no one has vouched for: each can do what the App can on this ruleset's refs. */
    others: BypassActor[]
    /** Other bypass actors a person has vouched cannot reach this repository (VOUCHED_ORG_BYPASSES). */
    vouched: { actor: BypassActor; vouch: VouchedBypass }[]
}

export type Gates = { org: OrgGate[]; problems: string[] }

/**
 * Whether a tag ruleset might apply to some release tag, judged generously: an include that does not start
 * `refs/tags/` (`~ALL`, `refs/**`) counts, as does one whose next character is `v` or a
 * wildcard; excludes are ignored. Over-counting only reports a ruleset to check by hand; under-counting would
 * let `verify` pass while the push is refused.
 */
function mayCoverReleaseTags(ruleset: RulesetBody): boolean {
    return (ruleset.conditions?.ref_name?.include ?? []).some((pattern) => {
        if (!pattern.startsWith('refs/tags/')) return true // ~ALL, refs/**, refs/t*/v*: judged as covering
        const rest = pattern.slice('refs/tags/'.length)
        return rest === '' || 'v*?['.includes(rest[0])
    })
}

/**
 * Every ruleset outside the four `planBypass` manages that could refuse the release's push: anything active on
 * `main` (read from the rules GitHub says apply there) and any tag ruleset covering a release tag. An
 * organisation ruleset is an org owner's step and is reported with its bypass list; another repository ruleset
 * is a problem, since the App would be refused by it and this tool does not manage it. `rulesets` holds every
 * ruleset that applies to the repository, the organisation's included, with details; one missing from it is
 * reported as unreadable.
 */
export function externalGates(
    activeOnMain: ActiveRule[],
    rulesets: Ruleset[],
    appId: number,
    vouches: readonly VouchedBypass[] = VOUCHED_ORG_BYPASSES,
): Gates {
    const managed = new Set([MAIN_CHECKS, MAIN_HISTORY, TAGS_CREATE, TAGS_IMMUTABLE])
    const byId = new Map(rulesets.map((ruleset) => [ruleset.id, ruleset]))
    const problems: string[] = []
    const org: OrgGate[] = []
    const seen = new Set<number>()

    const judge = (ruleset: Ruleset, types: string[], harmless: Set<string>) => {
        if (seen.has(ruleset.id)) return
        seen.add(ruleset.id)
        if (ruleset.source_type === 'Repository' && managed.has(ruleset.name)) return
        if (types.every((type) => harmless.has(type))) return
        if (ruleset.source_type !== 'Organization') {
            problems.push(
                `repository ruleset "${ruleset.name}" (${ruleset.id}, ${types.join(', ')}) also applies to the release's ` +
                    'push, and this tool does not manage it',
            )
            return
        }
        const actors = ruleset.bypass_actors ?? []
        const mine = actors.filter((actor) => actor.actor_type === 'Integration' && actor.actor_id === appId)
        const rest = actors.filter((actor) => !(actor.actor_type === 'Integration' && actor.actor_id === appId))
        const vouched = rest.flatMap((actor) => {
            const vouch = vouchedFor(ruleset.id, actor, vouches)
            return vouch ? [{ actor, vouch }] : []
        })
        org.push({
            id: ruleset.id,
            name: ruleset.name,
            types,
            app: mine.some((actor) => actor.bypass_mode === 'always' || actor.bypass_mode === 'exempt')
                ? 'listed'
                : mine.length > 0
                  ? 'wrong-mode'
                  : 'missing',
            others: rest.filter((actor) => !vouchedFor(ruleset.id, actor, vouches)),
            vouched,
        })
    }

    const typesOnMain = new Map<number, string[]>()
    for (const rule of activeOnMain)
        typesOnMain.set(rule.ruleset_id, [...(typesOnMain.get(rule.ruleset_id) ?? []), rule.type])
    for (const [id, types] of typesOnMain) {
        const ruleset = byId.get(id)
        if (!ruleset) problems.push(`could not read ruleset ${id}, which applies to main`)
        else judge(ruleset, types, HARMLESS_ON_MAIN)
    }
    for (const ruleset of rulesets) {
        if (ruleset.target === 'tag' && mayCoverReleaseTags(ruleset))
            judge(
                ruleset,
                (ruleset.rules ?? []).map((rule) => rule.type),
                HARMLESS_ON_A_NEW_TAG,
            )
    }
    // The checks ruleset must actually be in force on main, not merely named: GitHub's own list of the rules
    // that apply there has to carry its required_status_checks.
    const checks = rulesets.find((r) => r.source_type === 'Repository' && r.name === MAIN_CHECKS)
    if (
        checks &&
        !activeOnMain.some((rule) => rule.ruleset_id === checks.id && rule.type === 'required_status_checks')
    ) {
        problems.push(`"${MAIN_CHECKS}" is not in force on main: GitHub lists none of its required checks there`)
    }
    return { org, problems }
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
