/** Money helpers. Amounts cross the wire as integer cents. */

/** Convert a dollar amount to integer cents, rounding half away from zero. */
export const dollarsToCents = (dollars: number): number =>
    Math.sign(dollars) * Math.round(Math.abs(dollars) * 100);

/** Render integer cents as a dollar string, always two decimals. */
export const formatCents = (cents: number): string =>
    `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
