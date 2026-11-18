// @ts-check
// YAML scalars as the generator writes them: quoted so any value reads back as itself, and quoted the way the
// workspace's own Prettier would quote it, so `prettier --check .` stays green. Prettier's YAML printer keeps single
// quotes (the workspace's `singleQuote`) unless the value has an apostrophe and nothing double quotes would have to
// escape; then it writes double quotes, where the apostrophe needs no doubling.
import { CreateError } from './args.js'

/**
 * A quoted YAML scalar holding exactly `value`.
 * @param {string} value
 */
export function yamlString(value) {
    // A line break inside a quoted scalar folds into a space; a control character is not a path or a name.
    if (/\p{Cc}/u.test(value)) throw new CreateError(`${JSON.stringify(value)} holds a control character`)
    if (value.includes("'") && !/["\\]/.test(value)) return `"${value}"`
    return `'${value.replaceAll("'", "''")}'`
}
