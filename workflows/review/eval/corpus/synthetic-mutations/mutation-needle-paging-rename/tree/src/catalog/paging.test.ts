import {fetchPage, type Item} from "./paging";

const item = (id: string, rank: number): Item => ({
    id,
    title: `Item ${id}`,
    rank,
    archived: false,
});

const items = [item("a", 3), item("b", 2), item("c", 1)];

describe("fetchPage", () => {
    it("returns pageSize rows starting at offset", () => {
        expect(fetchPage(items, 1, 2).map((row) => row.id)).toEqual([
            "b",
            "c",
        ]);
    });

    it("returns a short page at the tail", () => {
        expect(fetchPage(items, 2, 5)).toHaveLength(1);
    });
});
