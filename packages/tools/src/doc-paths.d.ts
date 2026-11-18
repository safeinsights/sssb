/**
 * The gate that fails the build when a doctrine doc cites a path that does not exist, and the parser the adoption
 * rewriter shares with it. Everything about WHICH repository this is lives in the adopter's own root package.json
 * under `sssb.docPaths`, so the gate survives the day `packages/kit` leaves the tree.
 */

export interface DocPathsConfig {
    /** Prefixes that make a backticked token unambiguously a path in this repo (`docs/`, `apps/`, ...). */
    roots: string[]
    /**
     * Directories walked for `.md` files, and individual files, relative to the workspace root. Root-level files are
     * listed rather than globbed because a repo root accumulates markdown that is NOT doctrine: a stray NOTES.md
     * should not become a build gate.
     */
    include: string[]
    /**
     * Path prefixes (root-relative, forward slashes) never gated, each an append-only dated record or not this
     * checkout's content. Rewriting a record to match today's tree would be revisionist, so such files are corrected
     * opportunistically but never gated, and `init-app` never rewrites them. SSSB's own, with the reason for each:
     *
     * - `docs/adr/`: dated decisions, amended by appending a dated addendum, never by editing the body.
     * - `docs/build-notes.md`: a running log of dated lessons.
     * - `docs/decision-log.md`: a running log of dated decisions.
     * - `.claude/future-tasks/resolved/`: finished tasks; the work that resolved one routinely moved what it cites.
     * - `.claude/worktrees/`: linked worktrees from agent sessions, not this checkout's content.
     */
    exempt: string[]
    /**
     * Apps a citation may name while absent from the tree (SSSB: `showcase`, `starter`). Optional, default none, in
     * which case every citation is checked strictly. See `resolves` for the rule.
     */
    referenceApps?: string[]
    /**
     * Path segments that are build outputs, never checked. A doc may legitimately name one, but whether it exists on
     * disk depends on whether you happened to run a build, which would make the gate pass locally and fail on a clean
     * checkout: a gate whose verdict depends on build state is not a gate. Default: `dist-demo`, `.next`, `coverage`,
     * `playwright-report`, `test-results`, `node_modules`, `.data`.
     */
    buildOutputs?: string[]
}

/** One path a doc cites. */
export interface Citation {
    /** The path as the gate reads it: globs and `<metavariables>` truncated to their static prefix. */
    path: string
    /**
     * The full backticked span the path was read out of, which for a command citation is the whole command and can
     * be SHARED by several citations. `generalizeAppCitations` is the only sanctioned way to rewrite on it.
     */
    raw: string
    line: number
}

/**
 * Reads `sssb.docPaths` from `<root>/package.json` and validates its shape. Throws an `Error` naming the key when
 * the block is absent or malformed.
 */
export declare function readDocPathsConfig(root: string): DocPathsConfig

/**
 * Every gated markdown file, as root-relative forward-slash paths in a stable (sorted) order. Resolved against
 * `root`, never the process's working directory. An `include` entry that does not exist is skipped: an adopter may
 * have no `.claude/`.
 */
export declare function docFiles(root: string, config: DocPathsConfig): string[]

/** The path citations in a markdown text, one per path token inside each backticked span. */
export declare function citationsIn(text: string, config: DocPathsConfig): Citation[]

/** `citationsIn` over a file; `file` is resolved against `root`. */
export declare function citedPaths(file: string, config: DocPathsConfig, root: string): Citation[]

/**
 * Whether a cited path resolves under `root`. A directory citation must resolve outright; a FILE citation may also
 * pass on its parent directory existing, because a doc may legitimately name a file you are meant to create. A
 * citation under a reference app that is not in the tree (no `apps/<app>/package.json`) resolves, because it names
 * the template's own app and is not the adopter's to fix.
 */
export declare function resolves(path: string, root: string, config: DocPathsConfig): boolean

/**
 * Generalizes every citation of an `apps/<name>/` path that `isMissing` reports as gone into `apps/<app>/...`,
 * which the gate reads as asserting only that `apps/` exists. A span carrying several citations is rewritten once.
 */
export declare function generalizeAppCitations(
    text: string,
    isMissing: (path: string) => boolean,
    config: DocPathsConfig,
): string

/** Every broken citation under `root`, as `<file>:<line> cites \`<path>\``. */
export declare function docPathProblems(root: string, config: DocPathsConfig): string[]
