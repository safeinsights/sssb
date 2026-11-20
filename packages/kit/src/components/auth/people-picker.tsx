'use client'

import { Button, Stack, Text } from '@mantine/core'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

export interface PickerPerson {
    id: string
    name: string
    role: string
    tenantName: string
}

/**
 * Simulated-mode sign-in: the same card layout the real credential form uses, listing seeded
 * people. One auth UI in every mode (ADR-0003).
 *
 * `onPick` may answer a promise: one that resolves `false` or rejects (the sign-in was refused, the dev server is
 * down) clears the spinner so the person can pick again; anything else (`true`, or nothing, as an `async` handler
 * that returns no value resolves) keeps it while the page navigates.
 */
export function PeoplePicker({
    people,
    onPick,
}: {
    people: PickerPerson[]
    onPick: (id: string) => void | Promise<boolean | void>
}) {
    const t = useTranslations('auth')
    const [busy, setBusy] = useState<string | null>(null)

    return (
        <Stack gap="sm">
            <Text size="sm" c="gray.7">
                {t('personHint')}
            </Text>
            {people.map((person) => (
                <Button
                    key={person.id}
                    variant="light"
                    justify="space-between"
                    fullWidth
                    loading={busy === person.id}
                    data-testid={`person-${person.id}`}
                    rightSection={
                        <Text size="xs" c="gray.7">
                            {t('personMeta', { role: person.role, tenant: person.tenantName })}
                        </Text>
                    }
                    onClick={() => {
                        setBusy(person.id)
                        const result = onPick(person.id)
                        if (result) {
                            result.then(
                                (outcome) => {
                                    if (outcome === false) setBusy(null)
                                },
                                () => setBusy(null),
                            )
                        }
                    }}
                >
                    {person.name}
                </Button>
            ))}
        </Stack>
    )
}
