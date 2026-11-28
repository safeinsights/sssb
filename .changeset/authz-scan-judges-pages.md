---
'@sssb/kit': minor
---

### The authorization check judges pages, layouts and metadata routes as reads

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check (its id unchanged; its title and its second test now
name pages) reads every `page`, `layout`, `template`, `default`, `loading`, `not-found`, `global-not-found`,
`forbidden` and `unauthorized` file under `src/app`, and every metadata route (`sitemap`, `robots`, `manifest`,
`opengraph-image`, `twitter-image`, `icon`, `apple-icon`), with the route extensions. Each one's `default`,
`generateMetadata`, `generateImageMetadata`, `generateSitemaps` and `generateViewport` export is judged as a read
route handler is: it reaches `authorize(...)`, reads nothing, or passes an app entry's `reads-only` gate. A page that
reads org-scoped data without authorizing now fails, as a route already did: a page that called `auth.listMembers`
with no `authorize` showed a person with the role `none` the team's member names.

What the check newly **accepts**, in a page only (a route is judged as before):

- the session through `auth.getCurrentUser()`, `auth.requireUser()`, `auth.signInPath()`, `auth.refusal()` and
  `auth.listMyOrgs()` (`@sssb/kit/adapters/index`), each called;
- `setRequestLocale`, `getTranslations` and `getMessages` (`next-intl/server`), `hasLocale` and `useTranslations`
  (`next-intl`), `routing.locales` (`@sssb/kit/i18n/routing`), `canInActiveOrg` (`@sssb/kit/authz/authorize`),
  `isDemoMode` (`@sssb/kit/adapters/index`), `sameOriginPath` (`@sssb/kit/core/same-origin-path`), `getTenantTheme`
  (`@sssb/kit/theme`) and `mantineHtmlProps` (`@mantine/core`), each a named import under its exported name;
- a default import of a static asset (a `.css`, `.module.css` or `.scss` stylesheet, a `.png`, `.jpg`, `.jpeg`, `.gif`,
  `.svg`, `.webp`, `.avif` or `.ico` image) used as a value;
- an imported component used only as a JSX tag (by a named, default or namespace import) whose module is a client one
  (the file it resolves to opens with `'use client'`) or a package's (it resolves under `node_modules` or outside the
  app's directory, as `@sssb/kit`'s screens do);
- a component of the page's own file used only as a JSX tag (a function declared once and never reassigned, or a
  `const` bound to a function), whose code is read as part of the page;
- `const { Form } = await import('…')`, alone or as one element of an awaited global `Promise.all([...])` destructured
  the same way, when every name it binds is used only as a JSX tag and the module is a client one or a package's (the
  guide's shape for a real adapter's component);
- a `reads-only` entry under `outsideApi.files` keyed by a page, layout or metadata route file (`[locale]/signin/page.tsx`),
  not only a `route.*`; and an existing `outsideApi.prefixes` entry now covers the pages under it as well as the routes;
- a `'use client'` component file, or a page re-exporting a client component, which is skipped (a metadata route is
  judged whatever its prologue);
- a page under an intercepting segment (`(.)x`, Next's modal pattern) that authorizes or reads nothing.

What it newly **refuses**:

- a page's export that names anything else and does not reach `authorize(...)`: the seed, the simulated world, a port,
  a data helper, `db`, `analytics`, `next/og`'s `ImageResponse`, a value of the page's own file, a component passed as
  a value or called, and a server component of the app's own (a module under the app without `'use client'`, which may
  load its own data) rendered as a tag or loaded with `import()`: its name is counted, so the page authorizes or an
  entry lists it;
- `auth` (and `routing`) used any other way, whatever an entry lists: another member (`auth.listMembers`,
  `auth.getMember`, `routing.defaultLocale`), the object passed along, aliased, spread, destructured, read by a
  computed key, rendered as a tag (`<auth.listMembers />`) or reached through a namespace or `import()`, a listed method
  that is not called, and an `auth` or `routing` imported from any other module (an app's re-export included);
- any other `import()` (a module object, a renamed, defaulted or rest binding, a non-literal specifier, a second
  argument, a `let`, a `Promise.all` that is not the global, not awaited or given more than one argument) and a loaded
  name used other than as a JSX tag;
- any exemption for a page under an intercepting segment: it authorizes or reads nothing;
- an app entry of any gate kind but `reads-only` for a page, even under `src/app/api`; and a page under
  `src/app/api/service/` that is not wrapped by `withServiceCaller`;
- a `pages` or `src/pages` directory (the Pages Router), where before only `pages/api` failed, and a file named for a
  page, layout or metadata route with a code extension the check does not read (`page.mts`, `layout.cjs`, `page.mdx`,
  `page.page.tsx`).

Pages are matched by URL as routes are, so a route group's layout and its parent layout share one key
(`[locale]/layout.tsx`): one entry covers both, each judged on its own. The generated app ships an
`authz-exemptions.mjs` naming its two layouts' seed reads (`tenants`, `findTenant`) and its sign-in page's
simulated-mode picker (`listAllPeople`, `findTenant`).

**To adopt.** Run the conformance suite (`pnpm test:unit`). For each page it names:

- if the page reads org-scoped data, authorize the read in the page before it, as a route does:
  `authorize(user, user.orgSlug, 'read', { type: 'Membership', orgId: user.orgSlug })` before `auth.listMembers`, or
  your own subject before your own query; a read of the caller's own records authorizes its self-only subject
  (`{ type: 'AgreementAcceptance', ownerId: user.id }`);
- if it names a server component of your own, mark it `'use client'` if it is one, or, since it may load its own data,
  load in the page instead, authorize there, and pass the rows: the check cannot see into a component;
- if it reads nothing org-scoped (the seed, a public list), name it in `authz-exemptions.mjs` beside your
  `package.json`:

```js
export default {
    outsideApi: {
        files: {
            '[locale]/signin/page.tsx': {
                reason: "signed out by definition: the simulated-mode picker lists the simulated world's people",
                mustMatch: { kind: 'reads-only', names: ['findTenant', 'listAllPeople'] },
            },
        },
    },
}
```

If your app came from an earlier generator, copy the generated app's `authz-exemptions.mjs` from SSSB's
`apps/starter` at this release, or write the two entries above for your layouts and sign-in page. Two keys for one
URL (`[locale]/layout.tsx` and `[locale]/(protected)/layout.tsx`) are both refused: write the one.

**Now deletable.** A comment on a page saying it is kept to the authorization rule by hand.
