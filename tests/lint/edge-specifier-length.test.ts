import { describe, expect, it } from 'vitest'
import { lint } from './lint-text'

/**
 * `sssb/no-path-out-of-package` drops a relative specifier's `?query` or `#hash` before it judges where the path
 * lands. It used `/[?#].*$/`, which retried from every `?` in a long run whenever a newline followed it inside the
 * specifier (the rule trims the specifier first, so a trailing one does not count), and a linted file could make the
 * rule take time quadratic in that run: 4.6 s at 50,000 before the change. The cut is by index now.
 */
describe('the package-edge rule on a long query', () => {
    it('lints a specifier with a long run of ? before a newline in linear time', async () => {
        const file = 'packages/kit/src/server-lib/probe.ts'
        // The first lint loads the repository's config; time the second alone.
        await lint(file, "import { m } from '../core/x?raw'\nexport { m }\n")
        // The newline sits inside the specifier, not at its end: the rule trims the specifier before it cuts the query.
        const code = `import { m } from '../core/x${'?'.repeat(50_000)}\\ny'\nexport { m }\n`
        const started = performance.now()
        await lint(file, code)
        expect(performance.now() - started).toBeLessThan(1_000)
    })
})
