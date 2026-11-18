// @ts-check
// JSON written the way the generated workspace's own Prettier would write it, so its first `pnpm lint` (which runs
// `prettier --check .`) is green with no formatting pass: the generator has no dependencies, Prettier included.
//
// Prettier formats `package.json` with its `json-stringify` parser, which is JSON.stringify's layout (`packageJson`).
// Every other `.json` file gets its `json` parser (`formatJson`): an object that was written across lines stays across
// lines, and an array of plain values goes on one line when that line fits the print width (the workspace's
// `.editorconfig` sets 120 columns and an indent of 4). tests/tooling/create-generate.test.ts runs Prettier over the
// output to hold both to it.

const INDENT = '    '
const WIDTH = 120

/** @param {unknown} value */
const isPlain = (value) => value === null || typeof value !== 'object'

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {number} prefix the columns already taken on the line this value starts on
 * @returns {string}
 */
function format(value, depth, prefix) {
    if (isPlain(value)) return JSON.stringify(value)
    const inner = INDENT.repeat(depth + 1)
    const outer = INDENT.repeat(depth)
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]'
        if (value.every(isPlain)) {
            const line = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
            // The trailing comma Prettier may add after it counts against the width.
            if (prefix + line.length + 1 <= WIDTH) return line
        }
        return `[\n${value.map((item) => `${inner}${format(item, depth + 1, inner.length)}`).join(',\n')}\n${outer}]`
    }
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
    if (entries.length === 0) return '{}'
    return `{\n${entries
        .map(([key, item]) => {
            const head = `${inner}${JSON.stringify(key)}: `
            return `${head}${format(item, depth + 1, head.length)}`
        })
        .join(',\n')}\n${outer}}`
}

/**
 * A `.json` file's text, as Prettier's `json` parser lays it out.
 * @param {unknown} value
 */
export function formatJson(value) {
    return `${format(value, 0, 0)}\n`
}

/**
 * A `package.json`'s text, as Prettier's `json-stringify` parser (and npm) lay it out.
 * @param {unknown} value
 */
export function packageJson(value) {
    return `${JSON.stringify(value, null, 4)}\n`
}
