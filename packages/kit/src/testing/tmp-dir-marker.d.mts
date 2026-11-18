// The marker module is plain .mjs so the leak guard can import it under bare node; this declares it for TypeScript,
// which does not read a .mjs under node_modules even with allowJs, so tmp-dir.ts typechecks from the tarball too.
export declare const TMP_DIR_MARKER_SUFFIX: string
