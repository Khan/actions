import {setFrequency} from "../preferences/store";
import {buildDigest} from "./assemble";
import {queuePending} from "./pending";

const item = (userId: string, id: string, category: string) => ({
    id,
    userId,
    category,
    subject: `s-${id}`,
    body: `b-${id}`,
    at: Number(id.slice(1)),
});

describe("buildDigest", () => {
    it("returns null for immediate-frequency users", () => {
        queuePending(item("u1", "i1", "product_updates"));
        expect(buildDigest("u1")).toBeNull();
    });

    it("bundles queued items for weekly users", () => {
        setFrequency("u2", "weekly");
        queuePending(item("u2", "i1", "product_updates"));
        queuePending(item("u2", "i2", "billing"));
        const digest = buildDigest("u2");
        expect(digest?.itemCount).toBe(2);
        expect(digest?.subject).toContain("2 updates");
    });

    it("returns null when nothing is queued", () => {
        setFrequency("u3", "weekly");
        expect(buildDigest("u3")).toBeNull();
    });
});
