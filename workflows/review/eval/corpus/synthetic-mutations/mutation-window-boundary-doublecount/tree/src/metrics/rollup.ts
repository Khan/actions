import {queryEvents} from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;

export type DailyTotal = {
    dayStartMs: number;
    totalCents: number;
};

/** Sums revenue events into one row per day across [fromMs, toMs). */
export const dailyTotals = async (
    fromMs: number,
    toMs: number,
): Promise<DailyTotal[]> => {
    const totals: DailyTotal[] = [];
    for (let dayStart = fromMs; dayStart < toMs; dayStart += DAY_MS) {
        const dayEvents = await queryEvents(dayStart, dayStart + DAY_MS);
        totals.push({
            dayStartMs: dayStart,
            totalCents: dayEvents.reduce(
                (sum, event) => sum + event.valueCents,
                0,
            ),
        });
    }
    return totals;
};
