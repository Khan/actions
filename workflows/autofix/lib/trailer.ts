/**
 * The autofix commit trailer: the run's durable, machine-readable record.
 *
 * v1 runs once per arming, so nothing in v1 needs to know what a previous run
 * did. This module exists anyway, because the cycle counter a later continual
 * mode needs is nearly free to write now and genuinely awkward to backfill: the
 * only way to reconstruct it later would be to re-parse prose from commit
 * messages that were never written to be parsed.
 *
 * The branch itself is the store. Counting autofix commits on the head branch
 * gives a cycle count that survives cache eviction, needs no external state,
 * and is visible to a human reading the PR — the same reasoning that put the
 * reviewer's authoritative fingerprint in the review body rather than in cache
 * memory (`review.md` Step 6: "cache memory can be evicted, the review body
 * cannot"). It also fails in the right direction: a trailer that cannot be read
 * yields a lower cycle count, and the caller's rule is to stop when the count
 * cannot be established, not to continue.
 *
 * `Autofix-Threads` is the attempted-fingerprint ledger. It is what lets the
 * trial answer the question that actually matters — did the fix clear the
 * finding — by diffing attempted thread ids against the ones the next review
 * still reports open. A later no-progress guard reads the same field.
 */

/** Bumped when a field is added, removed, or retyped. */
export const TRAILER_SCHEMA_VERSION = 1;

export type AutofixTrailer = {
    schemaVersion: number;
    /** Scopes this run acted under, in resolver order. */
    scopes: string[];
    /** 1-based; always 1 in v1, the field the cadence axis will increment. */
    cycle: number;
    /** Thread ids this run attempted to address. */
    threadIds: string[];
};

const KEYS = {
    version: "Autofix-Version",
    scope: "Autofix-Scope",
    cycle: "Autofix-Cycle",
    threads: "Autofix-Threads",
} as const;

/**
 * Render the trailer block appended to the autofix commit message. Git trailers
 * are `Key: value` lines in the final paragraph, so the caller must place this
 * last, separated from the subject/body by a blank line.
 */
export const renderTrailer = (trailer: AutofixTrailer): string =>
    [
        `${KEYS.version}: ${trailer.schemaVersion}`,
        `${KEYS.scope}: ${trailer.scopes.join(",")}`,
        `${KEYS.cycle}: ${trailer.cycle}`,
        `${KEYS.threads}: ${trailer.threadIds.join(",")}`,
    ].join("\n");

/**
 * The final paragraph of a commit message, which is where git looks for
 * trailers.
 *
 * Scoping to it matters: an earlier version matched keys anywhere in the
 * message via a multiline regex, so a revert, or a doc commit quoting
 * `Autofix-Version: 1`, parsed as an autofix commit and inflated the cycle
 * count. Harmless while the count is only reported, load-bearing the moment a
 * cadence axis caps cycles on it.
 */
const lastParagraph = (message: string): string => {
    const paragraphs = message
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter((p) => p !== "");
    return paragraphs.length === 0 ? "" : paragraphs[paragraphs.length - 1];
};

const valueOf = (message: string, key: string): string | null => {
    const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
    const match = re.exec(lastParagraph(message));
    return match === null ? null : match[1].trim();
};

const splitList = (value: string | null): string[] =>
    value === null || value === ""
        ? []
        : value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry !== "");

/**
 * Parse a commit message's trailer. Returns null when the message carries no
 * autofix trailer or one stamped with a schema version this code does not
 * understand — both of which the caller treats as "not a readable autofix
 * commit".
 */
export const parseTrailer = (message: string): AutofixTrailer | null => {
    const rawVersion = valueOf(message, KEYS.version);
    if (rawVersion === null) {
        return null;
    }
    const schemaVersion = Number(rawVersion);
    if (
        !Number.isInteger(schemaVersion) ||
        schemaVersion !== TRAILER_SCHEMA_VERSION
    ) {
        return null;
    }
    const cycle = Number(valueOf(message, KEYS.cycle) ?? "");
    if (!Number.isInteger(cycle) || cycle < 1) {
        return null;
    }
    return {
        schemaVersion,
        scopes: splitList(valueOf(message, KEYS.scope)),
        cycle,
        threadIds: splitList(valueOf(message, KEYS.threads)),
    };
};

export type Ledger = {
    /** Readable autofix commits found on the branch. */
    cycles: number;
    /** The cycle number a new run would take. */
    nextCycle: number;
    /** Union of every thread id previously attempted, sorted. */
    attemptedThreadIds: string[];
};

/**
 * Summarise the autofix history recorded on a branch.
 *
 * `messages` is every commit message on the PR head. Commits without a readable
 * trailer are ignored rather than counted, which is the fail-closed direction
 * for the caller's stop rule: an unreadable history under-reports work already
 * done, so a cycle cap derived from it can only trip earlier, never later.
 */
export const summariseLedger = (messages: readonly string[]): Ledger => {
    const attempted = new Set<string>();
    let cycles = 0;
    let highest = 0;

    for (const message of messages) {
        const trailer = parseTrailer(message);
        if (trailer === null) {
            continue;
        }
        cycles++;
        highest = Math.max(highest, trailer.cycle);
        for (const id of trailer.threadIds) {
            attempted.add(id);
        }
    }

    return {
        cycles,
        nextCycle: highest + 1,
        attemptedThreadIds: [...attempted].sort(),
    };
};
