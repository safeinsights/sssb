// @ts-check
// The database an app's slug names, in a module of its own with no CDK in it, so a caller can refuse the same slugs
// the construct would without loading CDK (`sssb-app.js` re-exports it as `@sssb/cdk`'s `databaseNameFor`).

/** What a slug is: lowercase letters, digits and dashes, from a letter. */
export const SLUG = /^[a-z][a-z0-9-]*$/

/**
 * Names Aurora PostgreSQL refuses as a database name although they have its shape: PostgreSQL's reserved key words
 * (the "reserved" column of its SQL Key Words appendix) and the databases RDS and Postgres keep for themselves.
 * Amazon RDS's naming rules say a database name "can't be a word reserved by the database engine".
 */
const RESERVED = new Set([
    'all',
    'analyse',
    'analyze',
    'and',
    'any',
    'array',
    'as',
    'asc',
    'asymmetric',
    'both',
    'case',
    'cast',
    'check',
    'collate',
    'column',
    'constraint',
    'create',
    'current_catalog',
    'current_date',
    'current_role',
    'current_time',
    'current_timestamp',
    'current_user',
    'default',
    'deferrable',
    'desc',
    'distinct',
    'do',
    'else',
    'end',
    'except',
    'false',
    'fetch',
    'for',
    'foreign',
    'from',
    'grant',
    'group',
    'having',
    'in',
    'initially',
    'intersect',
    'into',
    'lateral',
    'leading',
    'limit',
    'localtime',
    'localtimestamp',
    'not',
    'null',
    'offset',
    'on',
    'only',
    'or',
    'order',
    'placing',
    'primary',
    'references',
    'returning',
    'select',
    'session_user',
    'some',
    'symmetric',
    'system_user',
    'table',
    'then',
    'to',
    'trailing',
    'true',
    'union',
    'unique',
    'user',
    'using',
    'variadic',
    'when',
    'where',
    'window',
    'with',
    'postgres',
    'rdsadmin',
    'template0',
    'template1',
])

/**
 * The database an app's slug names: the slug with each dash as an underscore. A slug is lowercase letters, digits
 * and dashes, and dashes are ordinary in one (`acme-corp`), but Aurora PostgreSQL's database name (the cluster's
 * `DatabaseName`, from `defaultDatabaseName`) may hold only letters, digits and underscores, start with a letter, run
 * to 63 characters and not be a word the engine reserves: a dashed slug synthesized cleanly and failed at deploy. A
 * slug has no underscore of its own, so two slugs never map to one name, and a slug with no dash maps to itself
 * (`showcase`, `starter`), so an existing deployment's database keeps its name. Throws for anything else.
 * @param {string} slug
 * @returns {string}
 */
export function databaseNameFor(slug) {
    if (!SLUG.test(slug)) throw new Error(`SssbApp: slug must be lowercase letters, digits and dashes (got "${slug}")`)
    const name = slug.replaceAll('-', '_')
    if (name.length > 63) {
        throw new Error(`SssbApp: slug "${slug}" is ${slug.length} characters; a database name may have at most 63`)
    }
    if (RESERVED.has(name)) {
        throw new Error(`SssbApp: slug "${slug}" names the database "${name}", a word Aurora PostgreSQL reserves`)
    }
    return name
}
