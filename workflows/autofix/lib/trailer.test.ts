import {describe, expect, it} from "vitest";

import {
    parseTrailer,
    renderTrailer,
    summariseLedger,
    TRAILER_SCHEMA_VERSION,
} from "./trailer.ts";

const trailer = {
    schemaVersion: TRAILER_SCHEMA_VERSION,
    scopes: ["blocking"],
    cycle: 1,
    threadIds: ["PRRT_a", "PRRT_b"],
};

const commit = (body: string): string =>
    `autofix: address reviewer feedback\n\n${body}`;

describe("renderTrailer / parseTrailer", () => {
    it("round-trips", () => {
        expect(parseTrailer(commit(renderTrailer(trailer)))).toEqual(trailer);
    });

    it("renders git-trailer syntax, one key per line", () => {
        const lines = renderTrailer(trailer).split("\n");
        expect(lines).toEqual([
            "Autofix-Version: 1",
            "Autofix-Scope: blocking",
            "Autofix-Cycle: 1",
            "Autofix-Threads: PRRT_a,PRRT_b",
        ]);
    });

    it("round-trips a multi-scope run", () => {
        const both = {...trailer, scopes: ["blocking", "nits"]};
        expect(parseTrailer(commit(renderTrailer(both)))?.scopes).toEqual([
            "blocking",
            "nits",
        ]);
    });

    it("round-trips an empty thread ledger", () => {
        const empty = {...trailer, threadIds: []};
        expect(parseTrailer(commit(renderTrailer(empty)))?.threadIds).toEqual(
            [],
        );
    });

    it("returns null for a commit with no trailer", () => {
        expect(parseTrailer("fix: unrelated human commit")).toBeNull();
    });

    it("returns null for a schema version it does not understand", () => {
        const future = renderTrailer(trailer).replace(
            "Autofix-Version: 1",
            "Autofix-Version: 99",
        );
        expect(parseTrailer(commit(future))).toBeNull();
    });

    it("returns null when the cycle is missing or not a positive integer", () => {
        for (const bad of ["", "0", "-1", "two"]) {
            const broken = renderTrailer(trailer).replace(
                "Autofix-Cycle: 1",
                `Autofix-Cycle: ${bad}`,
            );
            expect(parseTrailer(commit(broken))).toBeNull();
        }
    });

    it("tolerates extra whitespace after the key", () => {
        expect(
            parseTrailer(commit("Autofix-Version:  1\nAutofix-Cycle:\t2")),
        ).toMatchObject({cycle: 2});
    });
});

describe("summariseLedger", () => {
    it("reports an empty ledger for a branch with no autofix commits", () => {
        expect(summariseLedger(["feat: a", "fix: b"])).toEqual({
            cycles: 0,
            nextCycle: 1,
            attemptedThreadIds: [],
        });
    });

    it("counts cycles and unions attempted threads", () => {
        const first = commit(
            renderTrailer({...trailer, cycle: 1, threadIds: ["A", "B"]}),
        );
        const second = commit(
            renderTrailer({...trailer, cycle: 2, threadIds: ["B", "C"]}),
        );
        expect(summariseLedger(["feat: x", first, "fix: y", second])).toEqual({
            cycles: 2,
            nextCycle: 3,
            attemptedThreadIds: ["A", "B", "C"],
        });
    });

    it("derives the next cycle from the highest recorded, not the count", () => {
        // A squashed or dropped intermediate commit must not hand out a cycle
        // number that was already used.
        const third = commit(renderTrailer({...trailer, cycle: 3}));
        expect(summariseLedger([third]).nextCycle).toBe(4);
    });

    it("ignores unreadable trailers rather than counting them", () => {
        // Fail-closed direction: under-reporting past work can only make a
        // cycle cap trip earlier, never later.
        const unreadable = commit("Autofix-Version: 99\nAutofix-Cycle: 5");
        expect(summariseLedger([unreadable])).toEqual({
            cycles: 0,
            nextCycle: 1,
            attemptedThreadIds: [],
        });
    });

    it("sorts attempted ids so the ledger is comparable across runs", () => {
        const one = commit(renderTrailer({...trailer, threadIds: ["C", "A"]}));
        expect(summariseLedger([one]).attemptedThreadIds).toEqual(["A", "C"]);
    });
});
