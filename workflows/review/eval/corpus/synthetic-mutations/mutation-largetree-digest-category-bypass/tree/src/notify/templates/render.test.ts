import {renderItem} from "./render";

describe("renderItem", () => {
    it("renders through the category template", () => {
        const html = renderItem({
            id: "i1",
            userId: "u1",
            category: "billing",
            subject: "Invoice ready",
            body: "Your invoice for June is ready.",
            at: 1,
        });
        expect(html).toContain("Invoice ready");
    });

    it("falls back for unknown categories", () => {
        const html = renderItem({
            id: "i2",
            userId: "u1",
            category: "unknown",
            subject: "x",
            body: "y",
            at: 1,
        });
        expect(html).toContain("<h2>x</h2>");
    });
});
