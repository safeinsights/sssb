// The marker module is plain .mjs so the leak guard can import it under bare node; this declares it for TypeScript.
// Installed, the .mjs sits under node_modules, and at its default `maxNodeModuleJsDepth` of 0 TypeScript takes no
// types from a JavaScript file there, allowJs or not (TS7016), so without this tmp-dir.ts fails from the tarball.
export declare const TMP_DIR_MARKER_SUFFIX: string
