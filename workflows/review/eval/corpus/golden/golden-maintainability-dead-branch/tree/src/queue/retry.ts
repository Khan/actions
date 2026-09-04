export type FailureKind = "transient" | "throttled" | "fatal";

const MAX_ATTEMPTS = 6;
// The throttled ceiling is the upstream's documented retry-after maximum.
const THROTTLE_CAP_MS = 60_000;

/** Milliseconds to wait before the next attempt, or null to stop retrying. */
export const nextDelay = (attempt: number, kind: FailureKind): number | null => {
    if (kind === "fatal" || attempt >= MAX_ATTEMPTS) {
        return null;
    }
    switch (kind) {
        case "transient":
            return Math.min(500 * 2 ** attempt, 30_000);
        case "throttled":
            return Math.min(5_000 * 2 ** attempt, THROTTLE_CAP_MS);
        case "fatal":
            return null;
    }
};
