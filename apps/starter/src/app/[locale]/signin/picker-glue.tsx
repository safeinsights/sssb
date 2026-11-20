'use client'

import { PeoplePicker, type PickerPerson } from '@sssb/kit/components/auth/people-picker'
import { sameOriginPath } from '@sssb/kit/core/same-origin-path'

/** Client half of the simulated-mode sign-in: pick a person, POST it, land wherever we came from. */
export function PickerGlue({ people, returnTo }: { people: PickerPerson[]; returnTo: string }) {
    return (
        <PeoplePicker
            people={people}
            onPick={(personId) =>
                // `false` (or a rejection) tells the picker the sign-in failed, so its spinner clears.
                fetch('/api/auth/dev-signin', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ personId }),
                }).then((response) => {
                    if (!response.ok) return false
                    window.location.assign(sameOriginPath(returnTo) ?? '/')
                    return true
                })
            }
        />
    )
}
