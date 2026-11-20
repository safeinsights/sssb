---
'@sssb/eslint-plugin': minor
'@sssb/tools': minor
---

### Lint fences and `sssb` checks that let a form through

**Kind.** seam

**Action.** required

**What changed.**

- A new app-side fence, `sssb/no-path-into-kit`, in the preset and in `sssb check-fences`' probes. An import,
  `import()`, `require` or type import that reaches `@sssb/kit` by a path into the package
  (`../node_modules/@sssb/kit/src/...`, an absolute path, a `file:` URL), or any path through `node_modules`, fails
  lint. The kit ships its source, so such a path reached any internal past the exports map. A stylesheet or worker
  imported as `../node_modules/<package>/...` gets the same finding: import it by the package's name.
- An app's `sssb.vendors` entry must be a package name (`stripe`, `@stripe/stripe-js`) or one subpath of it
  (`firebase/app`), either followed by `/*`, or a whole scope (`@stripe/*`), in lower case. Any other gitignore
  pattern (`@stripe/**`, `stripe-*`, `stripe/`) banned an import declaration and let `import()` through; it now fails
  the lint config, naming the entry. `sssb check-fences` lints a probe per entry through both vendor rules.
- The import fences match a bare specifier cut at a resource query or hash too (`pg?raw`). The framework/app path
  fence and core's framework ban read `/// <reference>` directives.
- `sssb check-e2e` fails a spec, or a module it imports, that names an `@sssb/kit` subpath as a string esbuild
  cannot follow (a plain `require` of a variable, say), not only beside `createRequire`. An object key, a type, and a
  kit `.md` or `.json` file named in code pass.
- `sssb ci lint-typecheck-unit` holds doctor to every app it fans out over, as a bare `sssb doctor` does.
- `secretGrantProblems` and `dataApiShapeProblems` (`@sssb/tools/assembly-checks`) read grants from
  `AWS::IAM::RolePolicy`, `UserPolicy` and `GroupPolicy`, from users' and groups' inline and AWS-managed policies,
  and from a Secrets Manager resource policy on the cluster's secret, and fail any other `AWS::IAM::*` type that
  could carry a grant. A `?` in a granted resource is a wildcard. A stack built on `SssbApp` alone is unaffected.

**To adopt.** Run `pnpm lint` and `pnpm verify`. Import the framework by a published `@sssb/kit/...` subpath and any
package by its name. Rewrite a `sssb.vendors` entry the lint config refuses in one of the accepted shapes. If your
own infra fails an assembly check, the message names the resource that grants too much.
