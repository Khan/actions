import {buildPartnerReport} from "./partner-report";
import type {UsageEvent} from "./format-report";

const event = (feature: string): UsageEvent => ({
    userId: "u1",
    email: "u1@example.com",
    feature,
    at: 1,
});

describe("buildPartnerReport", () => {
    it("keeps only the partner's own features", () => {
        const rows = buildPartnerReport(
            [event("search"), event("editor"), event("search")],
            ["search"],
        );
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row["feature"] === "search")).toBe(true);
    });

    it("returns no rows when nothing matches", () => {
        const rows = buildPartnerReport([event("editor")], ["search"]);
        expect(rows).toHaveLength(0);
    });
});
