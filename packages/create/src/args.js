// @ts-check
// `@sssb/create`'s command line: one positional (the directory to create) and flags for everything else.
//
// The directory is the one argument the generator cannot do without, so it is positional. The rest is either
// derivable (the slug from the directory's name, the display name from the slug) or the adopter's identity (the
// repository and its code owners), and each of those wants its name at the call site: `--name "Acme Research"` says
// which of two strings is which.
import path from 'node:path'

export const PLACEHOLDER_OWNER = 'PLACEHOLDER_GITHUB_OWNER'
export const PLACEHOLDER_REPO = 'PLACEHOLDER_GITHUB_REPO'

export const USAGE = `usage: pnpm create @sssb <dir> [options]      (npm create @sssb <dir> -- [options])

Creates a new SSSB app workspace in <dir>, which must not exist or be empty: the app under apps/<slug>/ (with its
own infra/), the workspace's config on SSSB's presets, the owner files and a CI workflow calling SSSB's checks.

  --slug <slug>          the app's slug: lowercase letters, digits and dashes, from a letter. It names the app's
                         directory (apps/<slug>), its package, its cookies and its database (default: <dir>'s
                         name, lowercased)
  --name "<Name>"        the app's display name, in its copy and titles (default: the slug, title-cased)
  --repo <owner/name>    the GitHub repository the workspace will live in, for the security, conduct and issue
                         links (default: ${PLACEHOLDER_OWNER}/${PLACEHOLDER_REPO}, for you to replace)
  --owner <@handle>      a code owner for CODEOWNERS, a user or an @org/team; repeat for several (default: a
                         placeholder, for you to replace)
  --sssb <version|dir>   the @sssb/* packages to depend on, at this generator's version: that version, exact or
                         with ^ or ~ (default: ^<this generator's version>), or a directory of their packed tarballs
                         (sssb-kit-*.tgz and the rest), which are then depended on by file: path
  --workflow-ref <sha>   the commit of SSSB's reusable workflow to pin (default: the commit this generator was
                         packed from)
  --yes                  do not ask before writing
  --help                 print this`

/** A failure with a message for the person at the terminal; the CLI prints it (with the usage) and exits 1. */
export class CreateError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message)
        this.name = 'CreateError'
    }
}

/** What a slug is: lowercase letters, digits and dashes, from a letter (@sssb/cdk's SLUG). */
const SLUG = /^[a-z][a-z0-9-]*$/

/**
 * Names Aurora PostgreSQL refuses as a database name, a copy of @sssb/cdk's list (its database-name.js), so a slug the
 * construct would refuse at synth is refused here, where it is chosen. The generator depends on no SSSB package;
 * tests/tooling/create-args.test.ts holds the two lists equal.
 */
export const RESERVED_DATABASE_NAMES = new Set(
    (
        'all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create ' +
        'current_catalog current_date current_role current_time current_timestamp current_user default deferrable ' +
        'desc distinct do else end except false fetch for foreign from grant group having in initially intersect ' +
        'into lateral leading limit localtime localtimestamp not null offset on only or order placing primary ' +
        'references returning select session_user some symmetric system_user table then to trailing true union ' +
        'unique user using variadic when where window with postgres rdsadmin template0 template1'
    ).split(' '),
)

/**
 * Refuses a slug the app could not carry: the slug's shape, and the database it names (each dash an underscore, at
 * most 63 characters, not a word the engine reserves), as @sssb/cdk's `databaseNameFor` would at synth.
 * @param {string} slug
 */
export function checkSlug(slug) {
    if (!SLUG.test(slug))
        throw new CreateError(`"${slug}" is not a valid slug: lowercase letters, digits and dashes, from a letter`)
    const database = slug.replaceAll('-', '_')
    if (database.length > 63) throw new CreateError(`"${slug}" is too long: its database name may have 63 characters`)
    if (RESERVED_DATABASE_NAMES.has(database))
        throw new CreateError(`"${slug}" names the database "${database}", a word Aurora PostgreSQL reserves`)
}

/**
 * The slug's title case, the default display name (`acme-research` is "Acme Research").
 * @param {string} slug
 */
export function titleCase(slug) {
    return slug
        .split('-')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}

/** The widest a display name may be, in columns (a wide character counts two): its longest line stays in 120. */
const NAME_COLUMNS = 60

/**
 * The columns a string takes on a line, as Prettier counts them: a wide character (CJK, an emoji) takes two, a
 * combining mark or a joiner none.
 * @param {string} text
 */
export function columns(text) {
    let width = 0
    for (const char of text) {
        if (/^(?:\p{M}|\u200D|\uFE0F)$/u.test(char)) continue
        const wide =
            /\p{Extended_Pictographic}/u.test(char) ||
            /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u.test(
                char,
            )
        width += wide ? 2 : 1
    }
    return width
}

/**
 * The characters a display name may hold. It lands in TypeScript and JSON strings, an HTML `<title>`, markdown (a
 * heading, the middle of a sentence) and the app's message catalogs, which next-intl reads as ICU messages; each of the
 * characters left out means something in one of them (`* \` [ ] < > |` in markdown or HTML, `{ }` and `<tag>` in ICU,
 * `\` and `$` in strings). `_`, `~`, `#` and `&` are let in where they mean nothing (displayName's NAME_RULES).
 */
const NAME_CHARACTERS = /[^\p{L}\p{M}\p{N}\p{Extended_Pictographic} '’".,&()!?:/+%;=~_#-]/gu

/**
 * Where `_`, `~`, `#` and `&` would mean something in markdown, each with why. `#` at the start is the start rule's.
 * @type {[RegExp, string][]}
 */
const NAME_RULES = [
    [/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u, 'has a "_" that is not inside a word (markdown reads it as emphasis)'],
    [/~.*~/u, 'has more than one "~" (markdown reads a pair as strikethrough)'],
    [/\s#+$/u, 'ends in a "#" of its own (a markdown heading drops it)'],
    // `&copy;`, `&#169;`: markdown reads a character reference as the character. Only `;` ends one, so `R&D` is text;
    // `&#` is refused whatever follows.
    [/&(?:#|[\p{L}\p{N}]+;)/u, 'has an "&" that markdown reads as a character reference (as in "&amp;" or "&#38;")'],
]

/** The joiners an emoji sequence is built with (a zero-width joiner, an emoji presentation selector). */
const JOINERS = /\u200D|\uFE0F/gu

/**
 * The display name, as every file it lands in can carry it, Prettier-stable: control characters (a newline, a tab, a
 * bidirectional override) refused, whitespace trimmed and each run of it made one space, only the characters
 * NAME_CHARACTERS allows and where NAME_RULES allows them, from a letter or a digit (a leading `-`, `1.` or `#` would make a markdown line a list or a
 * heading), no `''` (an ICU message reads it as one apostrophe), at most NAME_COLUMNS wide.
 * @param {string} raw
 * @returns {string}
 */
export function displayName(raw) {
    if (/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(raw))
        throw new CreateError(
            `--name ${JSON.stringify(raw)} holds a control character (a newline, a tab): one line of text`,
        )
    const name = raw.trim().replace(/\s+/gu, ' ')
    if (name === '') throw new CreateError('--name is empty')
    const refused = [...new Set(name.replace(JOINERS, '').match(NAME_CHARACTERS) ?? [])]
    if (refused.length > 0) {
        throw new CreateError(
            `--name "${name}" uses ${refused.map((char) => `"${char}"`).join(' ')}: a display name is letters, digits, ` +
                `spaces and . , ' ’ " & ( ) ! ? : / + % ; = ~ _ # -, because the others mean something in the ` +
                'markdown, HTML and message catalogs it lands in',
        )
    }
    if (!/^[\p{L}\p{N}]/u.test(name))
        throw new CreateError(`--name "${name}" must start with a letter or a digit (it starts lines of markdown)`)
    for (const [pattern, why] of NAME_RULES) if (pattern.test(name)) throw new CreateError(`--name "${name}" ${why}`)
    if (name.includes("''"))
        throw new CreateError(`--name "${name}" has two apostrophes in a row, which the app's messages read as one`)
    if (columns(name) > NAME_COLUMNS) {
        throw new CreateError(
            `--name "${name}" is too long: at most ${NAME_COLUMNS} columns, a wide character counting two`,
        )
    }
    return name
}

/**
 * The GitHub repository, `owner/name`, in the characters GitHub allows.
 * @param {string} repo
 */
function checkRepo(repo) {
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo)
    if (!match || match[2] === '.' || match[2] === '..' || /\.git$/i.test(repo))
        throw new CreateError(`--repo "${repo}" is not a GitHub repository: owner/name, as in acme/research`)
}

/**
 * A code owner as CODEOWNERS names one: `@user` or `@org/team`. The `@` is added when it is left off.
 * @param {string} owner
 */
function normalOwner(owner) {
    const handle = owner.startsWith('@') ? owner : `@${owner}`
    if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]+)?$/.test(handle))
        throw new CreateError(`--owner "${owner}" is not a GitHub user or team: @user or @org/team`)
    return handle
}

/**
 * @typedef {{
 *   dir: string,
 *   slug: string,
 *   name: string,
 *   repo: string | null,
 *   owners: string[],
 *   sssb: string | null,
 *   workflowRef: string | null,
 *   yes: boolean,
 *   help: boolean,
 * }} Options
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
    /** @type {{ dir: string | null, slug: string | null, name: string | null, repo: string | null, owners: string[], sssb: string | null, workflowRef: string | null, yes: boolean, help: boolean }} */
    const options = {
        dir: null,
        slug: null,
        name: null,
        repo: null,
        owners: [],
        sssb: null,
        workflowRef: null,
        yes: false,
        help: false,
    }
    /** @type {Record<string, (value: string) => void>} */
    const takesValue = {
        '--slug': (value) => (options.slug = value),
        '--name': (value) => (options.name = value),
        '--repo': (value) => (options.repo = value),
        '--owner': (value) => options.owners.push(value),
        '--sssb': (value) => (options.sssb = value),
        '--workflow-ref': (value) => (options.workflowRef = value),
    }
    /** @type {Set<string>} */
    const seen = new Set()
    for (let index = 0; index < argv.length; index += 1) {
        const arg = /** @type {string} */ (argv[index])
        // `npm create @sssb <dir> -- --slug x` hands the `--` through; nothing here is a positional after it.
        if (arg === '--') continue
        const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
        const setter = flag === undefined ? undefined : takesValue[flag]
        if (setter && flag) {
            if (flag !== '--owner' && seen.has(flag)) throw new CreateError(`${flag} given twice`)
            seen.add(flag)
            const value = inline ?? argv[index + 1]
            if (value === undefined || value === '' || (inline === undefined && value.startsWith('--')))
                throw new CreateError(`${flag} needs a value`)
            setter(value)
            if (inline === undefined) index += 1
        } else if (arg === '--yes' || arg === '-y') options.yes = true
        else if (arg === '--help' || arg === '-h') options.help = true
        else if (arg.startsWith('-')) throw new CreateError(`unknown option ${arg}`)
        else if (options.dir === null) options.dir = arg
        else throw new CreateError(`unexpected argument "${arg}": the display name is a flag, --name "${arg}"`)
    }
    if (options.help) return { ...options, dir: options.dir ?? '', slug: '', name: '', help: true }
    if (options.dir === null) throw new CreateError('name the directory to create')

    const slug = options.slug ?? path.basename(path.resolve(options.dir)).toLowerCase()
    if (options.slug === null && !SLUG.test(slug))
        throw new CreateError(`the directory's name "${slug}" is not a valid slug: pass one with --slug`)
    checkSlug(slug)
    if (options.repo !== null) checkRepo(options.repo)
    if (options.workflowRef !== null && !/^[0-9a-f]{40}$/.test(options.workflowRef))
        throw new CreateError(`--workflow-ref "${options.workflowRef}" is not a full commit SHA (40 hex characters)`)
    return {
        ...options,
        dir: options.dir,
        slug,
        name: displayName(options.name ?? titleCase(slug)),
        owners: [...new Set(options.owners.map(normalOwner))],
    }
}
