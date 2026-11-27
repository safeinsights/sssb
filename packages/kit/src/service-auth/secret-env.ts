/**
 * An environment variable's name, as a shell would write it. Internal to service-auth (not in the `exports` map):
 * the verifiers that read a secret from a variable the caller names check the name here.
 */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/**
 * `name`, if it can name a server-only secret; otherwise a TypeError, since a bad name is a programming error, never
 * a 401. `NEXT_PUBLIC_*` is refused: Next copies those into the browser bundle wherever they are read by name, so a
 * secret under one is not a secret. `option` names the option in the message.
 */
export function serverSecretEnvName(name: string, option: string): string {
    if (!ENV_NAME.test(name) || name.startsWith('NEXT_PUBLIC_')) {
        throw new TypeError(
            `${option} must name a server-only environment variable (A-Z, 0-9 and _, not NEXT_PUBLIC_*), got ${JSON.stringify(name)}`,
        )
    }
    return name
}
