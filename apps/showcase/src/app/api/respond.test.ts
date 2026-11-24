import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from '@sssb/kit/ports/errors'
import { withPortErrors } from './respond'

afterEach(() => void vi.restoreAllMocks())

describe('withPortErrors', () => {
    it('answers a database that is waking up with a 503 to ask again, logged, and no detail of it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const response = await withPortErrors(() =>
            Promise.reject(new DatabaseUnavailableError('resuming', 'instance db-1 is resuming')),
        )
        expect(response.status).toBe(503)
        expect(response.headers.get('retry-after')).toBe('5')
        expect(await response.json()).toEqual({ error: 'database-unavailable', reason: 'resuming' })
        expect(warn).toHaveBeenCalledWith('database unavailable (resuming): instance db-1 is resuming')
    })
})
