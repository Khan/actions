import {describe, expect, it} from "vitest";

import {
    bodyItemId,
    isBodyItemId,
    parseCollapsedObservations,
} from "./collapsed.ts";

/**
 * The body-sourced observation parser (PRA-7): collapsed entries off the
 * latest review body, in the exact grammar `submission.ts` renders. The
 * work-list mechanics for these live in worklist.test.ts.
 */

const body = (entries: string[], title = "Non-blocking observations"): string =>
    [
        "Approved — no blocking issues found.",
        "<details>",
        `<summary>${title} (${entries.length}; top: something)</summary>`,
        "",
        ...entries,
        "",
        "</details>",
        "Note: re-review ran at scoped depth (re-review mode scoped, blocking-medium).",
    ].join("\n");

describe("parseCollapsedObservations", () => {
    it("parses entries with and without a source tag", () => {
        const observations = parseCollapsedObservations([
            {
                body: body([
                    "- `lib/rereview.ts:117` note (non-blocking): The reply guard never fires. <sub>(correctness-reviewer)</sub>",
                    "- `lib/a.ts:9` suggestion (non-blocking, documentation): Trim the doc.",
                ]),
            },
        ]);
        expect(observations).toEqual([
            {
                path: "lib/rereview.ts",
                line: 117,
                label: "note (non-blocking)",
                subject: "The reply guard never fires.",
                source: "correctness-reviewer",
            },
            {
                path: "lib/a.ts",
                line: 9,
                label: "suggestion (non-blocking, documentation)",
                subject: "Trim the doc.",
            },
        ]);
    });

    it("reads only the LATEST body carrying a collapsed section", () => {
        const observations = parseCollapsedObservations([
            {
                body: body([
                    "- `lib/old.ts:1` note (non-blocking): Stale entry.",
                ]),
            },
            {
                body: body(
                    ["- `lib/new.ts:2` note (non-blocking): Current entry."],
                    "Lower-confidence observations",
                ),
            },
            // A bare re-approve with no collapsed section does not erase the
            // scope the previous review stated.
            {body: "Approved — no blocking issues found."},
        ]);
        expect(observations.map((entry) => entry.path)).toEqual(["lib/new.ts"]);
    });

    it("skips pr-level and unparseable lines rather than throwing", () => {
        const observations = parseCollapsedObservations([
            {
                body: body([
                    "- note (non-blocking): A pr-level observation with no anchor.",
                    "- totally unrelated bullet",
                    "- `lib/a.ts:3` question (non-blocking): Parsed fine. <sub>(holistic)</sub>",
                ]),
            },
        ]);
        expect(observations).toHaveLength(1);
        expect(observations[0].path).toBe("lib/a.ts");
    });

    it("returns empty for no reviews or no collapsed sections", () => {
        expect(parseCollapsedObservations([])).toEqual([]);
        expect(
            parseCollapsedObservations([{body: "Changes requested."}]),
        ).toEqual([]);
    });
});

describe("body item ids", () => {
    it("are review-body prefixed and recognisable", () => {
        const id = bodyItemId({
            path: "lib/a.ts",
            line: 3,
            label: "note (non-blocking)",
            subject: "s",
        });
        expect(id).toBe("review-body:lib/a.ts:3");
        expect(isBodyItemId(id)).toBe(true);
        expect(isBodyItemId("PRRT_kwDOAbc123")).toBe(false);
    });
});
