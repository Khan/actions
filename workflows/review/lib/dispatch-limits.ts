/** Shared execution limits for production and live evaluation. */
export const DEFAULT_MAX_TURNS = 100;
// Fifteen minutes accommodates the heavy investigators, not just light checks.
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 4;
