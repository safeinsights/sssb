// @sssb/eslint-plugin (ADR-0014, part 4 and step P6): ONE plugin object carrying every sssb/* rule, and the app
// preset, `configs.app({ root })`. An app binds it as `sssb`; SSSB's own repository imports this same object for its
// internal blocks, so the two can never be "different plugins" for a file both match.
import { readFileSync } from 'node:fs'
import { appConfig } from './app-config.js'
import { rules } from './rules.js'

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** @type {import('./index.d.ts').SssbPlugin} */
const plugin = {
    meta: { name, version, namespace: 'sssb' },
    rules,
    configs: {
        app: (options) => appConfig(plugin, options),
    },
}

// Frozen, with every rule and its meta: an app's config is code, and one that rewrote a rule's `create` on this shared
// object could unfence its files while every config comparison still matched. A frozen object makes that a TypeError
// when the config loads.
for (const rule of Object.values(rules)) {
    Object.freeze(rule.meta)
    Object.freeze(rule)
}
Object.freeze(rules)
Object.freeze(plugin.meta)
Object.freeze(plugin.configs)
Object.freeze(plugin)

export default plugin
