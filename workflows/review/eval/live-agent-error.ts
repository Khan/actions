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
    /** Read-scope denials the attempt drew (see `LiveAgentResult.deniedReads`). */
    deniedReads?: number;
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
