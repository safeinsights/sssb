// THE FENCE PROBES `sssb check-fences` lints through an app's real, composed config: one virtual file per zone, at a
// path relative to the app, whose code every fence the preset applies there must report. Nothing is written to
// disk. Positive probes, bar one: the file a lint-exceptions.mjs entry names must NOT report (check-fences.js, step
// 3), since the app declared it exempt. Otherwise an app that bans MORE than the preset (a vendor SDK in its own real
// adapters, say) is tightening a fence, not loosening one, and check-fences leaves it alone.
//
// SSSB's own repository runs the same probes through its root config (tests/lint/check-fences.test.ts), so a probe
// that stops matching what the preset enforces fails there first.

/** The name every probe file carries, so it can never be a file the app has. */
export const PROBE = '__sssb_fence_probe__'

const IMPORTS_VENDOR = "import { S3Client } from '@aws-sdk/client-s3'\nexport const client = S3Client\n"
const LOADS_VENDOR = "export const load = () => import('@aws-sdk/client-s3')\n"
const READS_ENV = 'export const region = process.env.AWS_REGION\n'
const TAKES_RAW_DB = 'export const load = (db) => db.getDb()\n'
const IMPORTS_KIT_REAL =
    "import { createS3Storage } from '@sssb/kit/adapters/real/s3-storage'\nexport const s3 = createS3Storage\n"
const SCREEN =
    'export const Card = () => <p>Saved to the edge</p>\nexport const Save = () => <button aria-label="Save">x</button>\n'

/**
 * @typedef {{ path: string, code: string, fires: string[] }} Probe
 * `fires` lists the sssb/* rules that must each report at least once.
 * @type {Probe[]}
 */
export const PROBES = [
    {
        path: `src/domain/${PROBE}.ts`,
        code:
            `${IMPORTS_VENDOR}${LOADS_VENDOR}${READS_ENV}${TAKES_RAW_DB}${IMPORTS_KIT_REAL}` +
            "import { kv } from '@/adapters/real/kv'\nexport { kv }\n" +
            "import { Inter } from 'next/font/google'\nexport const font = Inter\n" +
            "export const suite = () => import('../../node_modules/@sssb/kit/src/testing/conformance/suite')\n",
        fires: [
            'sssb/no-path-into-kit',
            'sssb/no-vendor-import',
            'sssb/no-dynamic-vendor-import',
            'sssb/no-process-env',
            'sssb/no-raw-db-handle',
            'sssb/no-real-adapter-import',
            'sssb/no-kit-real-adapter-import',
            'sssb/no-next-font-google',
        ],
    },
    {
        path: `config/${PROBE}.ts`,
        code: `${IMPORTS_VENDOR}${READS_ENV}${IMPORTS_KIT_REAL}`,
        fires: ['sssb/no-vendor-import', 'sssb/no-process-env', 'sssb/no-kit-real-adapter-import'],
    },
    {
        path: `src/app/api/${PROBE}/route.ts`,
        code: `${IMPORTS_VENDOR}${READS_ENV}${TAKES_RAW_DB}${IMPORTS_KIT_REAL}`,
        fires: [
            'sssb/no-vendor-import',
            'sssb/no-process-env',
            'sssb/no-raw-db-handle',
            'sssb/no-kit-real-adapter-import',
        ],
    },
    {
        path: `src/app/${PROBE}.tsx`,
        code: SCREEN,
        fires: ['sssb/no-jsx-literals', 'sssb/no-literal-a11y-copy'],
    },
    {
        path: `src/components/${PROBE}.tsx`,
        code: `${SCREEN}${READS_ENV}${TAKES_RAW_DB}${IMPORTS_KIT_REAL}`,
        fires: [
            'sssb/no-jsx-literals',
            'sssb/no-literal-a11y-copy',
            'sssb/no-process-env',
            'sssb/no-raw-db-handle',
            'sssb/no-kit-real-adapter-import',
        ],
    },
    {
        path: `src/demo-static/${PROBE}.tsx`,
        code: SCREEN,
        fires: ['sssb/no-jsx-literals'],
    },
    // A route's or a screen's test keeps the tenancy ban; any test keeps the mkdtemp ban, and any test in src/ the ban
    // on a static import of SSSB's real adapters.
    {
        path: `src/components/${PROBE}.test.tsx`,
        code: `${TAKES_RAW_DB}import { mkdtempSync } from 'node:fs'\nexport const dir = mkdtempSync('x')\n${IMPORTS_KIT_REAL}`,
        fires: ['sssb/no-raw-db-handle', 'sssb/no-direct-mkdtemp', 'sssb/no-kit-real-adapter-import'],
    },
    {
        path: `tests/e2e/${PROBE}.spec.ts`,
        code: `import { mkdtempSync } from 'node:fs'\nexport const dir = mkdtempSync('x')\n${IMPORTS_VENDOR}`,
        fires: ['sssb/no-direct-mkdtemp', 'sssb/no-vendor-import'],
    },
    // The registry and the fakes keep the vendor and process.env bans, load real/ only through the registry's
    // import(), and never import SSSB's real adapters.
    {
        path: `src/adapters/fake/${PROBE}.tsx`,
        code:
            `${IMPORTS_VENDOR}${LOADS_VENDOR}${READS_ENV}` +
            "import { kv } from '../real/kv'\nimport { form } from '@sssb/kit/adapters/real/sign-in-form'\n" +
            "export { kv, form }\nexport const loadReal = () => import('../real/kv')\n" +
            'export const Save = () => <button aria-label="Save">x</button>\n',
        fires: [
            'sssb/no-vendor-import',
            'sssb/no-dynamic-vendor-import',
            'sssb/no-process-env',
            'sssb/no-static-real-adapter-import',
            'sssb/no-kit-real-adapter-import',
            'sssb/no-dynamic-real-adapter-import',
            'sssb/no-literal-a11y-copy',
            'sssb/no-jsx-literals',
        ],
    },
    // An app's real adapter may import its vendor and read its own configuration, but never the run mode.
    {
        path: `src/adapters/real/${PROBE}.tsx`,
        code:
            'export const mode = process.env.APP_MODE\n' +
            "import { Inter } from 'next/font/google'\nexport const font = Inter\n" +
            'export const Save = () => <button aria-label="Save">Save</button>\n',
        fires: [
            'sssb/no-run-mode-env',
            'sssb/no-next-font-google',
            'sssb/no-literal-a11y-copy',
            'sssb/no-jsx-literals',
        ],
    },
]

/**
 * The probes an app's OWN vendor list adds (`sssb.vendors`): for each entry, a module in src/domain that imports a
 * package the entry names, once by a declaration and once by import(), and both vendor rules must report it. The
 * composed config's options are already compared with the preset's (check-fences.js, step 1); this holds what the
 * rules DO with the app's list, both halves of the ban alike.
 * @param {readonly string[]} vendors entries already checked by loadAppVendors
 * @returns {Probe[]}
 */
export function vendorProbes(vendors) {
    return vendors.map((vendor, index) => {
        const specimen = vendor.endsWith('/*') ? `${vendor.slice(0, -1)}${PROBE}` : vendor
        return {
            path: `src/domain/${PROBE}vendor${index}.ts`,
            code:
                `import * as vendor from '${specimen}'\nexport { vendor }\n` +
                `export const load = () => import('${specimen}')\n`,
            fires: ['sssb/no-vendor-import', 'sssb/no-dynamic-vendor-import'],
        }
    })
}

/** What a module named in lint-exceptions.mjs is linted with: the act the exception lets through. */
export const EXCEPTION_PROBE_CODE = TAKES_RAW_DB
