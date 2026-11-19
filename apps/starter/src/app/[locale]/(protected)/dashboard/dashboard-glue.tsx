'use client'

import { useEffect, useState } from 'react'
import { DashboardScreen, type DashboardUser } from '@/components/dashboard-screen'
import { ItemsCard, type Item } from '@/components/items-card'

/** One page of items; no cursor is the first page. Null when the request failed, so a flaky network is a page that does not grow, not an unhandled rejection. */
async function fetchItemsPage(after: string | null): Promise<{ items: Item[]; nextCursor: string | null } | null> {
    try {
        const response = await fetch(after === null ? '/api/items' : `/api/items?cursor=${encodeURIComponent(after)}`)
        return response.ok ? ((await response.json()) as { items: Item[]; nextCursor: string | null }) : null
    } catch {
        return null
    }
}

export function DashboardGlue({ user, canCreateItem }: { user: DashboardUser; canCreateItem: boolean }) {
    const [items, setItems] = useState<Item[]>([])
    // The cursor for the NEXT page, or null at the end. The glue owns fetching; the card stays a plain list.
    const [cursor, setCursor] = useState<string | null>(null)

    useEffect(() => {
        // Sets state only once the response lands — the legitimate "sync with an external system"
        // case, so the react-hooks set-state-in-effect rule does not fire here.
        void fetchItemsPage(null).then((page) => {
            if (!page) return
            setItems(page.items)
            setCursor(page.nextCursor)
        })
    }, [])

    /** "Show older items" APPENDS the next page, so what the reader has scrolled past stays put. */
    async function loadMore() {
        const page = await fetchItemsPage(cursor)
        if (!page) return
        setItems((previous) => [...previous, ...page.items])
        setCursor(page.nextCursor)
    }

    return (
        <DashboardScreen user={user}>
            <ItemsCard
                items={items}
                canCreate={canCreateItem}
                hasMore={cursor !== null}
                onLoadMore={loadMore}
                onAdd={async (title) => {
                    const response = await fetch('/api/items', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ title }),
                    })
                    if (response.ok) {
                        const { item } = (await response.json()) as { item: Item }
                        setItems((prev) => [item, ...prev])
                    }
                }}
            />
        </DashboardScreen>
    )
}
