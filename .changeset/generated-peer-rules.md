---
'@sssb/create': patch
---

### The generated workspace installs without the eslint 10 peer warning

**Kind.** scaffold

**Action.** optional

**What changed.** The first `pnpm install` of a generated workspace printed "Issues with peer dependencies found", because `eslint-plugin-react` and `eslint-plugin-jsx-a11y`, which `@sssb/eslint-plugin`'s preset loads, declare eslint 9 as their highest peer while the preset and the workspace run eslint 10. No release of either lists eslint 10 yet. The generated `pnpm-workspace.yaml` now carries a `peerDependencyRules.allowedVersions` entry for exactly those two plugins, with a comment that says why and when to delete it.

**To adopt.** Nothing breaks if you do nothing; the warning is the only symptom. To silence it in an existing workspace, add this to `pnpm-workspace.yaml`, then delete it once `pnpm peers check` shows both plugins declare eslint 10:

```yaml
peerDependencyRules:
    allowedVersions:
        'eslint-plugin-react>eslint': '10'
        'eslint-plugin-jsx-a11y>eslint': '10'
```

**Now deletable.** Nothing.
