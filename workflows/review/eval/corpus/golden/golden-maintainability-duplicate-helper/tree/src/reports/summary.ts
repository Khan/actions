import type {LineItem} from "./types";

export type Summary = {count: number; totalCents: number; byCategory: Record<string, number>};

// Imported line items carry dollar amounts as floats; everything downstream
// is integer cents.
const toCents = (dollars: number): number =>
    Math.sign(dollars) * Math.round(Math.abs(dollars) * 100);

export const summarize = (items: readonly LineItem[]): Summary => {
    const byCategory: Record<string, number> = {};
    let totalCents = 0;
    for (const item of items) {
        const cents = item.cents ?? toCents(item.dollars ?? 0);
        totalCents += cents;
        byCategory[item.category] = (byCategory[item.category] ?? 0) + cents;
    }
    return {count: items.length, totalCents, byCategory};
};
