import {describe, expect, it} from "vitest";
import {findDependencyCycle, topologicallySortActions} from "./publish.ts";

describe("findDependencyCycle", () => {
    it("returns null for a dag", () => {
        const graph = {
            "json-args": [],
            "full-or-limited": ["json-args"],
            "gerald-pr": [],
        };
        expect(findDependencyCycle(graph)).toBe(null);
    });

    it("returns the full cycle path", () => {
        const graph = {
            a: ["b"],
            b: ["c"],
            c: ["a"],
        };
        expect(findDependencyCycle(graph)).toEqual(["a", "b", "c", "a"]);
    });
});

describe("topologicallySortActions", () => {
    it("orders dependencies before dependents", () => {
        const graph = {
            c: ["a", "b"],
            b: ["a"],
            a: [],
            d: [],
        };

        expect(topologicallySortActions(graph)).toEqual(["a", "b", "c", "d"]);
    });
});
