// @ts-check

/**
 * SSSB's optional ports, as an app's `params.ports` names them, and the switch each sets in the server's environment
 * (@sssb/kit's `adapters/real/optional-ports.ts`, which the framework reads at boot; this package's test checks the two
 * agree, through the framework each app resolves). A port left out of `params.ports` sets no switch, and the framework
 * then takes its default, which is what real mode required before the switches existed.
 */
export const PORT_SWITCHES = {
    llm: { variable: 'LLM_PROVIDER', choices: ['anthropic', 'none'] },
    email: { variable: 'EMAIL_PROVIDER', choices: ['mailgun', 'none'] },
    inboundEmail: { variable: 'INBOUND_EMAIL_PROVIDER', choices: ['mailgun', 'none'] },
    jobs: { variable: 'JOBS_RUNNER', choices: ['codebuild', 'in-process', 'none'] },
    storage: { variable: 'STORAGE_PROVIDER', choices: ['s3', 's3-compatible', 'none'] },
}

/**
 * The server's switches for an app's `params.ports`, or a thrown error naming what is wrong: an unknown port (a typo
 * would otherwise leave that port on) or a choice the framework does not know (it would refuse to boot).
 * @param {unknown} ports
 * @returns {Record<string, string>}
 */
export function portsEnvironment(ports) {
    if (ports === undefined) return {}
    if (typeof ports !== 'object' || ports === null || Array.isArray(ports)) {
        throw new Error(`SssbApp: params.ports must be an object (got ${JSON.stringify(ports)})`)
    }
    /** @type {Record<string, string>} */
    const env = {}
    for (const [port, choice] of Object.entries(ports)) {
        const known = /** @type {Record<string, { variable: string, choices: string[] }>} */ (PORT_SWITCHES)[port]
        if (known === undefined) {
            throw new Error(
                `SssbApp: params.ports.${port} is not an optional port (${Object.keys(PORT_SWITCHES).join(', ')})`,
            )
        }
        if (choice === undefined) continue
        if (!known.choices.includes(choice)) {
            throw new Error(
                `SssbApp: params.ports.${port} must be ${known.choices.join(', ')} (got ${JSON.stringify(choice)})`,
            )
        }
        env[known.variable] = choice
    }
    return env
}
