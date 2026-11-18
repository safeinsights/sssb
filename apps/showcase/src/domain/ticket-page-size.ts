/**
 * How many tickets the queue shows at once, and how many each "load more" adds. An APP decision, not
 * a framework one: the framework caps a page (`KEYSET_MAX_LIMIT`) but has no opinion on what reads
 * well on a support desk. Deliberately small so the seeded demo actually paginates in front of you —
 * a page size no seeded world ever reaches would be a pagination feature nobody can see working.
 *
 * Its own module, importing nothing, because a Playwright spec reads it (tickets-pagination.spec.ts) and a spec
 * may reach the kit only through `@sssb/kit/testing/e2e` (ADR-0014 part 2); ./tickets.ts, which imports the
 * kit's state machine, re-exports it for everything else.
 */
export const TICKET_PAGE_SIZE = 5
