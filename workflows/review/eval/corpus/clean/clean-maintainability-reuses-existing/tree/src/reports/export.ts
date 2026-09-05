import {dollarsToCents, formatCents} from "../money/cents";
import type {LineItem} from "./types";

// RFC 4180: a field containing a comma, a quote, or a newline is quoted, and
// quotes inside it are doubled.
const csvEscape = (field: string): string =>
    /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;

export const toCsv = (items: readonly LineItem[]): string => {
    const rows = [["id", "category", "amount"].join(",")];
    for (const item of items) {
        const cents = item.cents ?? dollarsToCents(item.dollars ?? 0);
        rows.push([csvEscape(item.id), csvEscape(item.category), formatCents(cents)].join(","));
    }
    return rows.join("\n");
};
