import type { EmailPort } from '../../ports/email'
import type { JobsPort } from '../../ports/jobs'
import type { LlmPort } from '../../ports/llm'
import { OPTIONAL_PORTS, type OptionalPort } from './optional-ports'

/**
 * A call through a port the deployment declared unused (`<SWITCH>=none`, ./optional-ports.ts). Thrown at the call,
 * never at boot: the app boots without the port, and only code that reaches for it fails, saying which switch to
 * change (the framework's deferred mail catches it and logs it: ../../server-lib/defer.ts). Not one of the port
 * errors routes map (`withPortErrors`), so a route that reaches it answers 500.
 */
export class AbsentPortError extends Error {
    constructor(port: OptionalPort) {
        const { variable } = OPTIONAL_PORTS[port]
        const rows = [...new Set(Object.values(OPTIONAL_PORTS[port].env).flatMap((env) => Object.values(env)))]
        super(
            `the ${port} port is absent: this deployment sets ${variable}=none, declaring that the app does not use ` +
                `it. To use it, set ${variable} and the settings it names (cutover row ${rows.join(', ')}).`,
        )
        this.name = 'AbsentPortError'
    }
}

function absent(port: OptionalPort): never {
    throw new AbsentPortError(port)
}

export const absentLlm: LlmPort = {
    complete: async () => absent('llm'),
    // Throws when called, not when iterated: the caller learns at once, before it streams anything to a client.
    stream: () => absent('llm'),
    runToolLoop: async () => absent('llm'),
}

export const absentEmail: EmailPort = {
    send: async () => absent('email'),
}

export const absentJobs: JobsPort = {
    start: async () => absent('jobs'),
}
