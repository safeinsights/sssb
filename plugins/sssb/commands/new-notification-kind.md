---
description: Add a notification kind (producer + copy) registered through the app-config seam
argument-hint: <entity.event, and who should hear about it>
---

Add a notification kind for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

The notifications machinery (fan-out, prefs, the bell component) is the framework's; kinds are vocabulary you
register:

1. **Register** in `src/app-config/notifications.ts`: add the kind to `appNotificationKinds` (`<entity>.<event>`
   naming), its payload shape to `AppNotificationPayloadMap` (small + jsonb-serializable), and its copy to
   `appNotificationCopy` (composed from payload fields). The keys it returns resolve in the APP catalog's
   `appNotifications` namespace (`notificationCopy` stamps the namespace, so app copy never goes near SSSB's
   catalog). Add the keys to BOTH `messages/en.json` and `messages/es.json`, and list the namespace in
   `APP_NAMESPACES` (`src/app-config/messages.ts`) if it is not there yet.
2. **Produce** it at the mutation choke point that causes it: call the framework's notify helper
   (`@sssb/kit/server-lib/notify`) after your route's write commits. Pick the recipient shape deliberately:
   `notifyAdmins` for a team's managers, `notifyMember` for one named person (exclude the actor, so acting on
   yourself is silent). The reference app produces
   `ticket.assigned` with `notifyMember` in `applyTicketChanges`
   (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/domain/ticket-changes.ts`), which its ticket
   route (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app/api/tickets/[id]/route.ts`) calls.
3. **Prefs ride free**: every registered kind appears in notification preferences (`NOTIFICATION_KINDS` composes
   framework ∪ app), with no extra wiring, wherever the app shows preferences.
4. **Test**: assert produce → fan-out (the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/notifications.test.ts`). That test
   is the server's proof: a generated app's header has no bell (`src/app/[locale]/(protected)/header-glue.tsx`
   passes none) and it has no profile screen with preferences, so on `pnpm dev` nothing displays a notification. To
   show them, add the reference app's: its header glue passes `bell` a `NotificationBell`
   (`@sssb/kit/components/notifications/notification-bell`) fed by its notification routes
   (`https://github.com/safeinsights/sssb/tree/<ref>/apps/showcase/src/app/api/notifications`), and its profile
   screen lists preferences through `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app/api/notification-prefs/route.ts`.
   The static demo already has both (the header bell and the profile screen's preferences): if the demo world
   produces the kind, mirror it in `src/demo-static/app.tsx` with `world.notifyMemberOf` or `world.notifyAdminsOf`
   and check it there. Finish with `pnpm verify`.
