'use client'

import { Button, Card, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

export interface Item {
    id: string
    title: string
}

/**
 * The app's ONE screen component: a list of the active team's items with an add box. Router-agnostic
 * (ADR-0006) so the Next route and the `file://` static twin render the same component; `canCreate`
 * comes from the same pure ability model on both sides.
 */
export function ItemsCard({
    items,
    onAdd,
    canCreate = true,
    hasMore = false,
    onLoadMore,
}: {
    items: Item[]
    /** Rejects when the item was not created: the card then keeps the draft and says so. */
    onAdd: (title: string) => Promise<void>
    /** When false (restricted members), the add affordance is disabled and a read-only hint shows. */
    canCreate?: boolean
    /** True while the server has older items to show. The list is paged (`@sssb/kit/db/keyset`). */
    hasMore?: boolean
    /** Appends the next page to `items`; the card shows "load more" only when both this and `hasMore` are set. */
    onLoadMore?: () => Promise<void>
}) {
    const t = useTranslations('items')
    const [draft, setDraft] = useState('')
    const [busy, setBusy] = useState(false)
    const [addFailed, setAddFailed] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)

    return (
        <Card withBorder padding="lg" radius="md" data-testid="items-card">
            <Stack gap="sm">
                <Title order={2} size="h3">
                    {t('title')}
                </Title>
                <Text size="sm" c="gray.7">
                    {t('hint')}
                </Text>
                {items.length === 0 ? (
                    <Text c="gray.7" data-testid="items-empty">
                        {t('empty')}
                    </Text>
                ) : (
                    <Stack gap={4} data-testid="items-list">
                        {items.map((item) => (
                            <Text key={item.id} data-testid="item-row">
                                {item.title}
                            </Text>
                        ))}
                    </Stack>
                )}
                {hasMore && onLoadMore ? (
                    <Button
                        size="compact-sm"
                        variant="default"
                        loading={loadingMore}
                        data-testid="items-load-more"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() => {
                            setLoadingMore(true)
                            onLoadMore().finally(() => setLoadingMore(false))
                        }}
                    >
                        {t('loadMore')}
                    </Button>
                ) : null}
                <Group align="end" gap="sm">
                    <TextInput
                        label={t('addLabel')}
                        flex={1}
                        value={draft}
                        disabled={!canCreate}
                        data-testid="item-input"
                        onChange={(event) => setDraft(event.currentTarget.value)}
                    />
                    <Button
                        loading={busy}
                        disabled={!canCreate || !draft.trim()}
                        data-testid="item-add"
                        onClick={() => {
                            setBusy(true)
                            setAddFailed(false)
                            onAdd(draft.trim())
                                .then(
                                    () => setDraft(''),
                                    () => setAddFailed(true),
                                )
                                .finally(() => setBusy(false))
                        }}
                    >
                        {t('addButton')}
                    </Button>
                </Group>
                {addFailed ? (
                    <Text size="sm" c="red.8" role="alert" data-testid="items-add-error">
                        {t('addError')}
                    </Text>
                ) : null}
                {!canCreate ? (
                    <Text size="sm" c="gray.7" data-testid="items-readonly-hint">
                        {t('readOnlyHint')}
                    </Text>
                ) : null}
            </Stack>
        </Card>
    )
}
