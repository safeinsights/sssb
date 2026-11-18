# Runbook: the release app

> **For SSSB's own repository** (`safeinsights/sssb`). The release app is the GitHub App whose token lets
> `.github/workflows/release.yml` push a release commit to `main` and create its `vX.Y.Z` tag. Since ADR-0014's
> P7 every merge to `main` that carries changesets cuts a release candidate, so make the app **before the first such
> merge**: until it exists, that merge's `push` job fails at minting the token, having written nothing, and the
> changesets stay pending for the next merge. The cutover row is `release-app` in `docs/cutover-checklist.md`.

## What a merge to `main` does once the app exists

While the packages are private (until P14), a release is a release candidate, and the merge is the decision: there
is no other step. Each run is in GitHub's Actions tab, workflow `release`.

1. **`plan`** waits for `checks` to pass on the merge commit, then `release.mjs prepare` versions every `@sssb/*`
   package to the next candidate (`0.2.0-rc.0` for the first, from `0.1.0` and minor changesets), writes the notes to
   `v<version>.md` under docs/releases in the release commit, and moves the consumed changesets to `.changeset/pre/`. Nothing pending (or only
   empty changesets) ends the run here, green, with the reason in its summary.
2. **`push`** checks that patch with `verify-release`, commits it as `chore: release v<version>`, tags it
   `v<version>`, and pushes both to `main` with the app's token. That push starts `checks` on the release commit and
   a second `release` run for the tag.
3. **`candidate`** (the tag's run) waits for `checks` to pass on the release commit, downloads the `sssb-tarballs`
   artifact its pack-and-consume job left, checks them (`release.mjs candidate`) and writes the prerelease's notes.
4. **`attest`** signs one build-provenance attestation per tarball.
5. **`prerelease`** creates the GitHub release as a draft, attaches the tarballs, downloads them again to check every
   byte, and only then publishes it as a prerelease that is never "Latest". A re-run finishes a draft a failed run
   left, and confirms a published candidate without changing it.

The push to `main` also runs `plan` again, on the release commit, which finds nothing pending and stops. If any step
fails, nothing later runs: a failed `push` leaves no tag (the push is atomic) and the next merge cuts the candidate; a
failed tag run is re-run from the Actions tab ("Re-run failed jobs"). Nothing is ever published to npm before P14.

`pnpm release-app:init` makes the App by GitHub's App-manifest flow (borrowed from CanopyCMS's
`init-github-app`), so its permissions come from code rather than from boxes ticked in settings. The code is
`scripts/release-app.ts` and `scripts/release-app/`. `tests/tooling/release-app-drift.test.ts` pins
`release.yml`'s `push` job, the one that holds the key, so any edit to it fails until someone re-reviews it
against the App's permissions.

## What the key is worth

The App holds `contents: write` (and the implied `metadata: read`) on `safeinsights/sssb` alone, and it
bypasses `main: required checks`, the organisation's `require-pr` and the creation rule on `v*` tags.
`release.yml` uses that for one `git push`. Anyone holding the key can do more:

- land any commit on `main` with no review and no checks, as long as it is a fast-forward (by git, by the
  contents API, or by merging any open pull request through the API, since the App bypasses `require-pr`);
- create any `vX.Y.Z` tag on such a commit, which starts `release.yml`'s publish half (`pack` still waits
  for `checks` to pass on that commit and refuses a tag that is not on `main`);
- create, move or delete any branch or tag no ruleset covers, and create releases.

Because it can land commits on `main`, it can change what workflows run there: `scripts/release.mjs`,
`package.json` scripts, `.nvmrc`. It cannot change a file under `.github/workflows/` (that needs the
`workflows` permission, which it lacks). Treat the key as worth a publish to npm. A required reviewer on
the `npm-publish` environment is the one setting that would still stand between a stolen key and npm.

What it cannot do:

| It may not                                       | Because                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| delete or force-push `main`                      | `main: history` forbids both and has no bypass                          |
| move or delete a `v*` tag                        | `release tags: v* immutable` forbids it and has no bypass               |
| reach another repository, or change a setting    | it has one installation and no other permission                         |
| be used from a workflow on any branch but `main` | its key is in the `release` environment, which deploys from `main` only |

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

    Add `--apply-bypass` (`pnpm release-app:init --apply-bypass`) to make the repository's ruleset changes
    at the end (it still shows them and waits for you to type `apply`); without it, they are shown and not made. `--name "<name>"` changes the
    App's display name (default `SafeInsights SSSB release`; App names are unique across GitHub).

2. Open the `file://` link it prints. The page posts the manifest to GitHub, which shows the App with its two
   permissions. Check them, and click **Create GitHub App**. The browser comes back to a page saying "App
   created".
3. The script stores the private key as the secret `RELEASE_BOT_PRIVATE_KEY` of the `release` environment
   (straight from memory into `gh secret set` on standard input; it is never written to disk or printed),
   and the client id as the variable `RELEASE_BOT_CLIENT_ID` (`release.yml` reads `vars.`, not
   `secrets.`). If `gh` fails, fix it in another terminal and press Enter: the key is held until you do.
4. Install the App from the link it prints: the **safeinsights** account, **Only select repositories**,
   **sssb**. Press Enter (anything typed before the prompt appeared is ignored). The script then reads the
   installation back as the App and checks, failing on anything else: owned by safeinsights, installed once,
   reaching `safeinsights/sssb` and nothing else, holding exactly `contents: write` and `metadata: read`. It
   also checks, with your own `gh`, that the organisation lists one installation of the App with that client
   id; `bypass` and `verify` run the same check, so a mistyped `--app-id` never becomes a bypass.
5. The ruleset changes, in the order shown (the rulesets with no bypass are created first, so nothing is
   ever less protected than before):
    - create `main: history` (deletion, non-fast-forward; no bypass);
    - create `release tags: v* immutable` (update, deletion, non-fast-forward; no bypass);
    - `main: required checks`: the App becomes its only bypass;
    - `release tags: v*`: keeps only the creation rule, and the App becomes its only bypass.

    With `--apply-bypass` the script makes them; otherwise run
    `pnpm release-app bypass --app-id <id> --apply` later, or make them by hand from the printed bodies.

6. **By hand, the organisation's half, and only after step 5's `main: history` exists** (until then the
   bypass would let the App delete or force-push `main`). The script never changes an organisation ruleset.
   In `https://github.com/organizations/safeinsights/settings/rules/<id>` for each ruleset it lists (today
   `require-pr`, 7484436), add the App to the bypass list as **Always allow** (not "For pull requests only",
   which `verify` reports as not done) and change nothing else. `verify` also fails while any other actor is
   on that list: `release.yml` assumes the release app is the only one that can push to `main` without a
   reviewed PR. Today `require-pr` also lists the App with id 4038189.
7. Check it all, changing nothing:

    ```bash
    pnpm release-app verify --app-id <id>
    ```

    It checks the environment (main only, admins not exempt, key and client id present), that the id is the
    release app (as in step 4), and every ruleset the release's push meets, the organisation's included. A
    stored secret cannot be read back, so it does not read the App back as the App unless you hand it a key on
    standard input (`--key-stdin`); step 4 already did that once.

## When something goes wrong

- **The redirect never arrives, or the exchange fails.** (A network failure or a GitHub error is offered a
  retry first.) The App may exist with no key stored. Do not just re-run: that makes a second App. Either
  delete the App (its settings page, Advanced) and run again, which is safest since the exchange's one-time
  code stays in the browser's history until it expires; or generate a private key on the App's page and
  store it yourself, then delete the downloaded file:
  `gh secret set RELEASE_BOT_PRIVATE_KEY --env release --repo safeinsights/sssb < key.pem`. Not the "client
  secret": that is for OAuth and fails when used to sign.
- **The script refuses because the environment already holds the key.** An App may already exist. Run
  `verify`; to start over, delete the App, the secret and the variable first.
- **The readback finds the App on more repositories, or with "All repositories".** Change the installation
  to this repository alone (the organisation's installed-apps settings), then run `verify`.

## Rotating the key

On the App's page, generate a new private key and store it as in the first recovery step above. Before
deleting the downloaded file, prove it with `pnpm release-app verify --app-id <id> --key-stdin < key.pem`.
Then delete the file, and the old key on the App's page. If the file may have been copied anywhere (a synced
or backed-up Downloads folder), rotate again.
