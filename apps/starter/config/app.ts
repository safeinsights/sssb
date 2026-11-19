/**
 * App identity — the single source of truth for MECHANICAL identifiers.
 *
 * Doctrine: identifiers that a tool, protocol, or platform keys on and that can COLLIDE across
 * apps (session/viewpoint cookies, the fake-auth JWT issuer, the service-token audience, infra
 * resource names) DERIVE from this slug, so an adopter renames the app in exactly ONE place.
 * Identifiers that are purely origin- or process-scoped are instead given NEUTRAL names that
 * never need renaming. Human-facing DISPLAY copy lives in `messages/*.json`, never here.
 *
 * `pnpm create @sssb` sets this value when it generates the app (along with the display copy and the few
 * files that name the app's directory).
 *
 * It is also what lets two apps in one workspace run side by side in one browser: the slug prefixes the
 * session cookie (`starter_session` here), so signing into one app never signs you into — or out
 * of — another whose slug differs.
 */
export const APP_SLUG = 'starter'
