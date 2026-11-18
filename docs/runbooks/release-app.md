# Runbook: the release app

> **For SSSB's own repository** (`safeinsights/sssb`). The release app is the GitHub App whose token lets
> `.github/workflows/release.yml` push a release commit to `main` and create its `vX.Y.Z` tag. Nothing
> publishes before ADR-0014's P14, so this can be done any time before then; the cutover row is
> `release-app` in `docs/cutover-checklist.md`.

`pnpm release-app:init` makes the App by GitHub's App-manifest flow (borrowed from CanopyCMS's
`init-github-app`), so its permissions come from code rather than from boxes ticked in settings. The code is
`scripts/release-app.ts` and `scripts/release-app/`; `tests/tooling/release-app-drift.test.ts` fails if
`release.yml` starts using the App for anything its permissions were not chosen for.

## What the App may do, and what it may not

| It may                                                     | Because                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| push to `main` and create `v*` tags in `safeinsights/sssb` | `contents: write` (and the implied `metadata: read`), installed on this repository only |
| pass `main`'s required checks and pull-request rule        | it is the bypass on `main: required checks` and on the organisation's `require-pr`      |
| create a `v*` tag                                          | it is the only bypass on `release tags: v*`, which now holds only the creation rule     |

| It may not                                                    | Because                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| delete or force-push `main`                                   | `main: history` forbids both and has no bypass                          |
| move or delete a `v*` tag                                     | `release tags: v* immutable` forbids it and has no bypass               |
| touch workflows, PRs, issues, settings, or another repository | it has no other permission and one installation                         |
| be used from any branch but `main`                            | its key is in the `release` environment, which deploys from `main` only |

A bypass actor bypasses every rule in its ruleset, not one rule, which is why deletion and force-pushes live
in rulesets the App does not bypass. The org's `require-pr` also forbids both, but the App bypasses it.

## Before you start

- You are an **owner of the safeinsights organisation** and an **admin of `safeinsights/sssb`**, and `gh` is
  signed in as you (`gh auth status`).
- The `release` environment exists, deploys from `main` only, and does not exempt administrators. It does
  (made 2026-11-17); the script checks again and stops if not.
- A browser on this machine, signed in to GitHub as you. An embedded or app-internal browser that is not
  signed in appears to do nothing when you click Create.

## Steps

1. Run it:

    ```bash
    pnpm release-app:init
    ```

    Add `--apply-bypass` (`pnpm release-app:init --apply-bypass`) to make the repository's ruleset changes at the end (it still shows them and
    waits for you to type `apply`); without it, they are shown and not made. `--name "<name>"` changes the
    App's display name (default `SafeInsights SSSB release`; App names are unique across GitHub).

2. Open the `file://` link it prints. The page posts the manifest to GitHub, which shows the App with its two
   permissions. Check them, and click **Create GitHub App**. The browser comes back to a page saying "App
   created".
3. The script stores the private key as the secret `RELEASE_BOT_PRIVATE_KEY` of the `release` environment
   (straight from memory into `gh secret set` on standard input; it is never written to disk or printed),
   and the client id as the variable `RELEASE_BOT_CLIENT_ID` (`release.yml` reads `vars.`, not
   `secrets.`). If `gh` fails, fix it in another terminal and press Enter: the key is held until you do.
4. Install the App from the link it prints: the **safeinsights** account, **Only select repositories**,
   **sssb**. Press Enter. The script then reads the installation back as the App and checks, failing on
   anything else: owned by safeinsights, installed once, reaching `safeinsights/sssb` and nothing else,
   holding exactly `contents: write` and `metadata: read`.
5. The ruleset changes, in the order shown (the rulesets with no bypass are created first, so nothing is
   ever less protected than before):
    - create `main: history` (deletion, non-fast-forward; no bypass);
    - create `release tags: v* immutable` (update, deletion, non-fast-forward; no bypass);
    - `main: required checks`: the App becomes its only bypass;
    - `release tags: v*`: keeps only the creation rule, and the App becomes its only bypass.

    With `--apply-bypass` the script makes them; otherwise run
    `pnpm release-app bypass --app-id <id> --apply` later, or make them by hand from the printed bodies.

6. **By hand, the organisation's half.** The script never changes an organisation ruleset. In
   `https://github.com/organizations/safeinsights/settings/rules/<id>` for each ruleset it lists (today
   `require-pr`, 7484436), add the App to the bypass list as **Always allow** and change nothing else. While
   there, look at who else is on that list: `release.yml` assumes the release app is the only actor that can
   push to `main` without a reviewed PR.
7. Check it all, changing nothing:

    ```bash
    pnpm release-app verify --app-id <id>
    ```

    It checks the environment (main only, admins not exempt, key and client id present) and every ruleset,
    the organisation's included. A stored secret cannot be read back, so it does not re-read the App as the
    App unless you hand it a key on standard input (`--key-stdin`); step 4 already did that once.

## When something goes wrong

- **The redirect never arrives, or the exchange fails.** The App may exist with no key stored. Do not just
  re-run: that makes a second App. Either delete the App (its settings page, Advanced) and run again, or
  generate a private key on the App's page and store it yourself, then delete the downloaded file:
  `gh secret set RELEASE_BOT_PRIVATE_KEY --env release --repo safeinsights/sssb < key.pem`. Not the "client
  secret": that is for OAuth and fails when used to sign.
- **The script refuses because the environment already holds the key.** An App may already exist. Run
  `verify`; to start over, delete the App, the secret and the variable first.
- **The readback finds the App on more repositories, or with "All repositories".** Change the installation
  to this repository alone (the organisation's installed-apps settings), then run `verify`.

## Rotating the key

On the App's page, generate a new private key; store it as in the first recovery step above; delete the
downloaded file; then delete the old key on the App's page. The next release run proves the new one.
