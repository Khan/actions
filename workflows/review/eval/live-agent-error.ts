/**
 * A dispatch failure that carries what the attempt counted before it threw.
 *
 * A timed-out or non-success run is exactly the attempt most likely to have
 * gone looking outside the staged case, so its denials must reach the
 * report; a bare throw would zero them. Runners throw this in place of a
 * plain Error when they have counts to keep, and `dispatchWithRetry` in
 * live-producer.ts folds `partial` into the per-agent report on the way to
 * the retry.
 */

/** The counters a failed attempt still measured before it died. */
export type PartialAccounting = {
    /** Tool calls the attempt made (see `LiveAgentResult.toolCalls`). */
    toolCalls?: number;
    /** Out-of-scope reads denied (see `LiveAgentResult.deniedReads`). */
    deniedReads?: number;
    /** Non-read tools denied (see `LiveAgentResult.deniedTools`). */
    deniedTools?: number;
};

/**
 * Add one attempt's counters into a running total (the per-agent report).
 * A counter the attempt did not report leaves the total untouched, so a
 * runner that cannot count still reports nothing rather than a false zero.
 */
export const addAccounting = (
    into: PartialAccounting,
    from: PartialAccounting,
): void => {
    for (const key of ["toolCalls", "deniedReads", "deniedTools"] as const) {
        const n = from[key];
        if (n !== undefined) {
            into[key] = (into[key] ?? 0) + n;
        }
    }
};

export class LiveAgentError extends Error {
    readonly partial: PartialAccounting;

    constructor(
        message: string,
        partial: PartialAccounting,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "LiveAgentError";
        this.partial = partial;
    }
}
