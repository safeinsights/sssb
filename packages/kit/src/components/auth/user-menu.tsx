'use client'

import { Avatar, Menu, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { useTranslations } from 'next-intl'
import { SignOutIcon, UserIcon } from './auth-icons'
import { PreviewRow } from './preview-row'

export interface MenuUser {
    name: string
    email: string
}

/**
 * Lean take on Clerk's UserButton (ADR-0003): an avatar trigger opening a popover whose header is
 * the user preview row (name + email), then the account actions with leading icons.
 */
export function UserMenu({
    user,
    onProfile,
    onSignOut,
}: {
    user: MenuUser
    /** Omit in an app that mounts no profile route — the entry is then not offered at all, which is
     *  the UI form of ADR-0012's "unused capability = empty registration". */
    onProfile?: () => void
    onSignOut: () => void
}) {
    const t = useTranslations('auth')

    return (
        <Menu position="bottom-end" width={260}>
            <Menu.Target>
                {/* The trigger shows only initials. They are a symbol, like a "B" on a Bold button, not a
                    label (WCAG 2.5.3's carve-out), so they are aria-hidden and a visually hidden line names
                    the button with the user's full name (the email when the name is blank). Named by its
                    content, never an aria-label: axe 4.14 compares an aria-label with the on-screen
                    initials. A checker that compares the computed name instead may still flag this. */}
                <UnstyledButton data-testid="user-menu">
                    <VisuallyHidden>{t('userMenuLabel', { name: user.name.trim() || user.email })}</VisuallyHidden>
                    <Avatar
                        name={user.name}
                        aria-hidden
                        radius="xl"
                        styles={{ placeholder: { color: '#fff', background: 'var(--mantine-color-dark-6)' } }}
                    />
                </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
                <Menu.Label>
                    <PreviewRow name={user.name} title={user.name} subtitle={user.email} rounded />
                </Menu.Label>
                <Menu.Divider />
                {onProfile ? (
                    <Menu.Item leftSection={<UserIcon />} onClick={onProfile} data-testid="menu-profile">
                        {t('profileLink')}
                    </Menu.Item>
                ) : null}
                <Menu.Item leftSection={<SignOutIcon />} onClick={onSignOut} data-testid="menu-signout">
                    {t('signOut')}
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    )
}
