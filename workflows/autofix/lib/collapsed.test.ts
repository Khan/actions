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

    it("reads only the NEWEST review's body, by submittedAt", () => {
        const observations = parseCollapsedObservations([
            {
                body: body(
                    ["- `lib/new.ts:2` note (non-blocking): Current entry."],
                    "Lower-confidence observations",
                ),
                submittedAt: "2026-08-24T02:00:00Z",
            },
            {
                body: body([
                    "- `lib/old.ts:1` note (non-blocking): Stale entry.",
                ]),
                submittedAt: "2026-08-24T01:00:00Z",
            },
        ]);
        expect(observations.map((entry) => entry.path)).toEqual(["lib/new.ts"]);
    });

    it("a newest review with no collapsed section yields no body items", () => {
        // An older section describes a tree the currency machinery does not
        // vouch for (stamps do not survive posting), so it is not read; the
        // observation drops out of scope until a review re-derives it.
        expect(
            parseCollapsedObservations([
                {
                    body: body([
                        "- `lib/old.ts:1` note (non-blocking): Stale entry.",
                    ]),
                },
                {body: "Approved — no blocking issues found."},
            ]),
        ).toEqual([]);
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

    it("still parses a legacy body whose section had its own <details> fold", () => {
        // Every PR in flight when KORE-2632 landed has a prior review body
        // in the old shape, and the work list reads the LATEST body: the
        // legacy `<summary>` carrier (named-top teaser included) must keep
        // parsing.
        const observations = parseCollapsedObservations([
            {
                body: [
                    "Approved.",
                    "",
                    "<details>",
                    "<summary>Lower-confidence observations (1; top: " +
                        "`lib/legacy.ts:9` suggestion (non-blocking): Old shape.</summary>",
                    "",
                    "- `lib/legacy.ts:9` suggestion (non-blocking): " +
                        "Old shape. <sub>(documentation)</sub>",
                    "",
                    "</details>",
                ].join("\n"),
            },
        ]);
        expect(observations).toEqual([
            {
                path: "lib/legacy.ts",
                line: 9,
                label: "suggestion (non-blocking)",
                subject: "Old shape.",
                source: "documentation",
            },
        ]);
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
        expect(id).toBe("review-body:lib/a.ts:3:note");
        expect(isBodyItemId(id)).toBe(true);
        expect(isBodyItemId("PRRT_kwDOAbc123")).toBe(false);
    });

    it("still parses a legacy body whose section had its own <details> fold", () => {
        // Every PR in flight when KORE-2632 landed has a prior review body
        // in the old shape, and the work list reads the LATEST body: the
        // legacy `<summary>` carrier (named-top teaser included) must keep
        // parsing.
        const observations = parseCollapsedObservations([
            {
                body: [
                    "Approved.",
                    "",
                    "<details>",
                    "<summary>Lower-confidence observations (1; top: " +
                        "`lib/legacy.ts:9` suggestion (non-blocking): Old shape.</summary>",
                    "",
                    "- `lib/legacy.ts:9` suggestion (non-blocking): " +
                        "Old shape. <sub>(documentation)</sub>",
                    "",
                    "</details>",
                ].join("\n"),
            },
        ]);
        expect(observations).toEqual([
            {
                path: "lib/legacy.ts",
                line: 9,
                label: "suggestion (non-blocking)",
                subject: "Old shape.",
                source: "documentation",
            },
        ]);
    });
});

/**
 * A minimal fs over an in-memory file map, enough for runSubmissionCli.
 * Writes land back in the map so staged artifacts are inspectable.
 */
const makeFakeFs = (files: Record<string, string>) => ({
    readFileSync: (p: string) => {
        if (!(p in files)) {
            throw new Error(`ENOENT: ${p}`);
        }
        return files[p];
    },
    writeFileSync: (p: string, data: string) => {
        files[p] = data;
    },
    existsSync: (p: string) =>
        p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    mkdirSync: () => {},
});

describe("the render/parse round trip", () => {
    it("parses what runSubmissionCli actually renders", async () => {
        // The one test that owns both ends of the grammar: a full-depth plan
        // whose budget sheds a claim, the review body it renders, and this
        // module's parse of that body. If the renderer's line shape moves,
        // this is the test that goes red.
        const {runSubmissionCli} = await import(
            "../../review/lib/submission.ts"
        );
        const REVIEW = "/tmp/gh-aw/review";
        const files: Record<string, string> = {
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [
                    {
                        id: "kept",
                        source: "correctness-reviewer",
                        path: "lib/a.ts",
                        line: 2,
                        label: "suggestion (non-blocking)",
                        subject: "Kept inline.",
                        discussion: "Kept inline.",
                        failure_scenario: "f",
                        confidence: 0.9,
                    },
                    {
                        id: "shed",
                        source: "documentation",
                        path: "lib/b.ts",
                        line: 7,
                        label: "suggestion (non-blocking, documentation)",
                        subject: "Trim the doc comment.",
                        discussion: "Trim the doc comment.",
                        failure_scenario: "f",
                        confidence: 0.3,
                    },
                ],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "full",
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        };
        const plan = runSubmissionCli(makeFakeFs(files));
        const observations = parseCollapsedObservations([{body: plan.body}]);
        expect(observations).toEqual([
            {
                path: "lib/b.ts",
                line: 7,
                label: "suggestion (non-blocking, documentation)",
                subject: "Trim the doc comment.",
                source: "documentation",
            },
        ]);
    });

    it("round-trips the N>=2 form off a body rendered in the new shape", async () => {
        // Two shed claims, so the section carries more than one entry, and
        // the assertions pin the CURRENT shape off the renderer (not a
        // hand-built fixture): one `review details` fold, a bold heading
        // instead of a per-section `<summary>`, and both entries parsed
        // back out from under it (KORE-2632).
        const {runSubmissionCli} = await import(
            "../../review/lib/submission.ts"
        );
        const REVIEW = "/tmp/gh-aw/review";
        const shed = (
            id: string,
            path: string,
            line: number,
            subject: string,
            confidence: number,
        ) => ({
            id,
            source: "documentation",
            path,
            line,
            label: "suggestion (non-blocking, documentation)",
            subject,
            discussion: subject,
            failure_scenario: "f",
            confidence,
        });
        const files: Record<string, string> = {
            [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
                depth: "full",
                claims: [
                    {
                        id: "kept",
                        source: "correctness-reviewer",
                        path: "lib/a.ts",
                        line: 2,
                        label: "suggestion (non-blocking)",
                        subject: "Kept inline.",
                        discussion: "Kept inline.",
                        failure_scenario: "f",
                        confidence: 0.9,
                    },
                    shed("shed-1", "lib/b.ts", 7, "Trim the doc comment.", 0.4),
                    shed("shed-2", "lib/c.ts", 3, "Expand the example.", 0.3),
                ],
            }),
            [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
                depth: "full",
                mode: "full",
                stampAnchorDraft: false,
                stampHunks: {},
            }),
        };
        const plan = runSubmissionCli(makeFakeFs(files));
        expect(plan.body).toContain(
            "**Lower-confidence observations (2):**\n\n- ",
        );
        // One fold for the whole tail, and no per-section wrapper.
        expect(plan.body.split("<details>").length - 1).toBe(1);
        expect(plan.body).not.toContain("<summary>Lower-confidence");
        expect(plan.body).not.toContain("<details open>");
        const observations = parseCollapsedObservations([{body: plan.body}]);
        expect(observations).toHaveLength(2);
        expect(observations).toEqual(
            expect.arrayContaining([
                {
                    path: "lib/b.ts",
                    line: 7,
                    label: "suggestion (non-blocking, documentation)",
                    subject: "Trim the doc comment.",
                    source: "documentation",
                },
                {
                    path: "lib/c.ts",
                    line: 3,
                    label: "suggestion (non-blocking, documentation)",
                    subject: "Expand the example.",
                    source: "documentation",
                },
            ]),
        );
    });

    it("still parses a legacy body whose section had its own <details> fold", () => {
        // Every PR in flight when KORE-2632 landed has a prior review body
        // in the old shape, and the work list reads the LATEST body: the
        // legacy `<summary>` carrier (named-top teaser included) must keep
        // parsing.
        const observations = parseCollapsedObservations([
            {
                body: [
                    "Approved.",
                    "",
                    "<details>",
                    "<summary>Lower-confidence observations (1; top: " +
                        "`lib/legacy.ts:9` suggestion (non-blocking): Old shape.</summary>",
                    "",
                    "- `lib/legacy.ts:9` suggestion (non-blocking): " +
                        "Old shape. <sub>(documentation)</sub>",
                    "",
                    "</details>",
                ].join("\n"),
            },
        ]);
        expect(observations).toEqual([
            {
                path: "lib/legacy.ts",
                line: 9,
                label: "suggestion (non-blocking)",
                subject: "Old shape.",
                source: "documentation",
            },
        ]);
    });
});
