import {recordEvent} from "./db";
import {dailyTotals} from "./rollup";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("dailyTotals", () => {
    it("sums each day's events", async () => {
        await recordEvent({name: "sale", valueCents: 100, at: DAY_MS + 5});
        await recordEvent({name: "sale", valueCents: 250, at: DAY_MS + 90});
        const totals = await dailyTotals(DAY_MS, 2 * DAY_MS);
        expect(totals).toHaveLength(1);
        expect(totals[0]?.totalCents).toBe(350);
    });

    it("returns one row per day", async () => {
        const totals = await dailyTotals(0, 3 * DAY_MS);
        expect(totals).toHaveLength(3);
    });
});
