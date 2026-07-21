import {digestItems} from "./digest";

describe("digestItems", () => {
    it("renders an empty digest without error", () => {
        expect(digestItems([])).toEqual([]);
    });
});
