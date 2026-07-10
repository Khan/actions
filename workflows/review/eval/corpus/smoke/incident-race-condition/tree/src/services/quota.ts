import {kvGet, kvSet} from "../store/kv";

/** Per-tenant daily API quota accounting. */
const quotaKey = (tenantId: string, day: string): string =>
    `quota:${tenantId}:${day}`;

/** Usage above this ceiling is clamped rather than recorded. */
const DAILY_CEILING = 1_000_000;

/**
 * Record `amount` units of usage, clamped to the daily ceiling, and return
 * the new total.
 */
export const recordUsage = async (
    tenantId: string,
    day: string,
    amount: number,
): Promise<number> => {
    const key = quotaKey(tenantId, day);
    const current = (await kvGet<number>(key)) ?? 0;
    const next = Math.min(current + amount, DAILY_CEILING);
    await kvSet(key, next);
    return next;
};

/** Read the current usage total (0 when unset). */
export const currentUsage = async (
    tenantId: string,
    day: string,
): Promise<number> => {
    return (await kvGet<number>(quotaKey(tenantId, day))) ?? 0;
};
