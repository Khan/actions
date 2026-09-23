import {describe, expect, it} from "vitest";

import {
    answeredThreadsFromMemory,
    includeAnsweredQuestions,
    parseReconciliation,
    verifiedAnsweredQuestions,
} from "./answered-questions";
import {suppressTrackedDuplicates} from "./dedup-adjudicated";
import fixture from "./fixtures/answered-scope-42048.json";

const thread = fixture.thread;
const author = "Bcdirito";
const decision = {
    resolve: [thread.thread_id],
    keep: [],
    answered: [thread.thread_id],
};

const verify = (
    threads: unknown = [thread],
    reconciliation: unknown = decision,
    prAuthor: unknown = author,
) => verifiedAnsweredQuestions(threads, reconciliation, prAuthor);

const withReplies = (...comments: unknown[]) => [
    {...thread, comments: [thread.comments[0], ...comments]},
];

describe("answered scope question evidence", () => {
    it("preserves legacy decisions and filters malformed answer ids", () => {
        expect(
            parseReconciliation({resolve: ["fixed", 1], keep: null}),
        ).toEqual({resolve: ["fixed"], keep: [], skipLines: []});
        expect(
            parseReconciliation({
                ...decision,
                answered: [thread.thread_id, null, 1],
            }),
        ).toEqual({...decision, skipLines: []});
    });
    it.each([
        ["missing decision", null],
        ["legacy output", {resolve: [thread.thread_id], keep: []}],
        ["unknown id", {...decision, answered: ["ghost"]}],
        ["not resolved", {...decision, resolve: []}],
        ["contradictory keep", {...decision, keep: [thread.thread_id]}],
        ["malformed ids", {...decision, answered: thread.thread_id}],
    ])("rejects %s", (_name, reconciliation) => {
        expect(verify([thread], reconciliation)).toEqual([]);
    });

    it.each([
        undefined,
        null,
        "",
        " ",
        "github-actions",
        "github-actions[bot]",
        "autofix[bot]",
        "someone-else",
    ])("requires an attributable PR-author reply (%s)", (prAuthor) => {
        expect(verifiedAnsweredQuestions([thread], decision, prAuthor)).toEqual(
            [],
        );
    });

    it.each([
        ["no replies", withReplies()],
        ["empty reply", withReplies({author, body: " "})],
        ["bot reply", withReplies({author: "github-actions", body: "Done"})],
        ["malformed reply", withReplies(null, "answer")],
        [
            "human opener",
            [
                {
                    ...thread,
                    comments: [
                        {...thread.comments[0], author},
                        ...thread.comments.slice(1),
                    ],
                },
            ],
        ],
        [
            "blocking question",
            [
                {
                    ...thread,
                    comments: [
                        {
                            ...thread.comments[0],
                            body: "**question (blocking):** Is the guard fixed?",
                        },
                        ...thread.comments.slice(1),
                    ],
                },
            ],
        ],
        [
            "non-question defect",
            [
                {
                    ...thread,
                    comments: [
                        {
                            ...thread.comments[0],
                            body: "**suggestion (non-blocking):** Fix the guard.",
                        },
                        ...thread.comments.slice(1),
                    ],
                },
            ],
        ],
    ])("rejects %s", (_name, threads) => {
        expect(verify(threads)).toEqual([]);
    });

    it("invalidates memory on an edited answer, edited opener, or new reply", () => {
        const memory = verify();
        expect(answeredThreadsFromMemory([thread], memory)).toHaveLength(1);
        for (const threads of [
            withReplies({author, body: "That ticket is for something else."}),
            withReplies(...thread.comments.slice(1), {
                author,
                body: "Reopening this.",
            }),
            [
                {
                    ...thread,
                    comments: [
                        {
                            ...thread.comments[0],
                            body: `${thread.comments[0].body} Changed ask.`,
                        },
                        ...thread.comments.slice(1),
                    ],
                },
            ],
        ]) {
            expect(answeredThreadsFromMemory(threads, memory)).toEqual([]);
        }
        expect(
            answeredThreadsFromMemory(
                [thread],
                [{...memory[0], conversation: "forged"}],
            ),
        ).toEqual([]);
        expect(answeredThreadsFromMemory([thread], null)).toEqual([]);
    });

    it("never suppresses a blocking re-presentation of the answered question", () => {
        const adjudicated = includeAnsweredQuestions(null, [thread], decision, {
            author,
        });
        expect(adjudicated).toEqual([{...thread, answeredBy: author}]);
        const nonblocking = suppressTrackedDuplicates(
            [fixture.candidate],
            [thread],
            adjudicated,
            new Set(decision.resolve),
        );
        expect(nonblocking.kept).toEqual([]);
        expect(nonblocking.suppressed).toEqual([
            expect.objectContaining({
                id: fixture.candidate.id,
                thread_id: thread.thread_id,
                adjudicated: true,
            }),
        ]);
        const candidate = {...fixture.candidate, label: "issue (blocking)"};
        const result = suppressTrackedDuplicates(
            [candidate],
            [thread],
            adjudicated,
            new Set(decision.resolve),
        );
        expect(result.kept).toEqual([candidate]);
        expect(result.suppressed).toEqual([]);
    });

    it("fails toward posting on malformed staging", () => {
        expect(verify({threads: [thread]})).toEqual([]);
        expect(verify([null, {}, "thread"])).toEqual([]);
        expect(
            verify([{...thread, comments: [null, ...thread.comments]}]),
        ).toEqual([]);
        expect(
            answeredThreadsFromMemory(
                [{thread_id: thread.thread_id}],
                verify(),
            ),
        ).toEqual([]);
        expect(includeAnsweredQuestions({}, [thread], decision, null)).toEqual(
            [],
        );
    });
});
