import {describe, it, expect} from "vitest";

import {
    buildUnifiedDiff,
    hashHunkAddedLines,
    runStagePrCli,
    type GhGet,
    type StagePrFs,
} from "./stage-pr";
import type {TicketFetch} from "./stage-ticket";
import type {GhGraphql} from "./threads";
import {computeHunkSignature, renderRereviewStampLine} from "./rereview-mode";
import {renderVersionFooterLine} from "./version-footer";

/**
 * Foreign reviewer history in the staging: when the newest bot review came
 * from another install or major version (or carries no readable footer), the
 * run stages a first encounter. The fixtures mirror stage-pr-canary.test.ts's.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (
    files: Record<string, string> = {},
): StagePrFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) =>
            p in state || Object.keys(state).some((f) => f.startsWith(`${p}/`)),
        mkdirSync: () => {},
    };
};

const ghGetFromMap =
    (routes: Record<string, unknown>): GhGet =>
    (path: string) => {
        if (!(path in routes)) {
            return Promise.reject(new Error(`unexpected GET ${path}`));
        }
        return Promise.resolve(routes[path]);
    };

const noTicket = (): TicketFetch => () =>
    Promise.reject(new Error("unexpected ticket fetch"));

const PR_META = {
    number: 7,
    title: "t",
    body: "d",
    user: {login: "octo"},
    base: {ref: "main"},
    head: {sha: "abc123", ref: "feature/KORE-9"},
    draft: false,
};

const PATCH_ONE = "@@ -1,2 +1,3 @@\n ctx\n+added line\n ctx";

const reviewBody = (version: string, install: string | null): string =>
    `review\n<details><summary><sub>review details</sub></summary>\n${renderVersionFooterLine(
        {
            version,
            install,
            schemaVersion: 2,
            depth: "full",
            reReviewMode: "fast",
            blockingOnly: false,
            blockingMedium: false,
            enabledReviewers: [],
            nonBlockingInlineBudget: null,
        },
    )}\n${renderRereviewStampLine({
        schemaVersion: 1,
        depth: "full",
        verdict: "REQUEST_CHANGES",
        anchorDraft: false,
        anchorHunks: computeHunkSignature(
            buildUnifiedDiff([
                {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            ]),
        ),
    })}\n</details>`;

const botThread = (): GhGraphql => () =>
    Promise.resolve({
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        pageInfo: {hasNextPage: false},
                        nodes: [
                            {
                                id: "PRRT_human",
                                isResolved: false,
                                path: "a.ts",
                                line: 3,
                                comments: {
                                    nodes: [
                                        {
                                            author: {login: "octo"},
                                            body: "human question",
                                            url: "https://github.com/o/r/pull/7#discussion_r2",
                                        },
                                    ],
                                },
                            },
                            {
                                id: "PRRT_adjudicated",
                                isResolved: true,
                                resolvedBy: {login: "octo"},
                                path: "a.ts",
                                line: 4,
                                comments: {
                                    nodes: [
                                        {
                                            author: {login: "github-actions"},
                                            body: "**nit (non-blocking):** settled",
                                            url: "https://github.com/o/r/pull/7#discussion_r3",
                                        },
                                    ],
                                },
                            },
                            {
                                id: "PRRT_bot",
                                isResolved: false,
                                path: "a.ts",
                                line: 2,
                                comments: {
                                    nodes: [
                                        {
                                            author: {login: "github-actions"},
                                            body: "**issue (blocking):** old finding",
                                            url: "https://github.com/o/r/pull/7#discussion_r1",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                },
            },
        },
    });

const stage = async (
    body: string,
    identity: {major: number; install: string} | null | undefined,
) => {
    const fs = makeFakeFs({
        "/tmp/gh-aw/cache-memory/pr-7.json": JSON.stringify({
            verdict: "REQUEST_CHANGES",
            wasDraft: false,
            reviewedHunks: {"a.ts": [hashHunkAddedLines(PATCH_ONE)]},
        }),
        "/work/.github/aw/review/ROUTING": "re-review fast\n",
    });
    const result = await runStagePrCli(
        fs,
        ghGetFromMap({
            "/repos/o/r/pulls/7": PR_META,
            "/repos/o/r/pulls/7/files?per_page=100&page=1": [
                {filename: "a.ts", status: "modified", patch: PATCH_ONE},
            ],
            "/repos/o/r/pulls/7/reviews?per_page=100&page=1": [
                {
                    id: 11,
                    state: "CHANGES_REQUESTED",
                    user: {login: "github-actions[bot]"},
                    body,
                    submitted_at: "2026-07-01T00:00:00Z",
                },
            ],
        }),
        botThread(),
        noTicket(),
        {
            repo: "o/r",
            prNumber: 7,
            repoRoot: "/work",
            ...(identity === undefined ? {} : {identity}),
        },
    );
    const plan = JSON.parse(fs.files[`${REVIEW}/rereview-plan.json`]);
    return {fs, result, plan};
};

describe("foreign reviewer history", () => {
    it("keeps history when the install and major match (a minor bump)", async () => {
        const {fs, result, plan} = await stage(reviewBody("2.0.0", "review"), {
            major: 2,
            install: "review",
        });
        expect(
            JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`]),
        ).toHaveLength(1);
        expect(result.botThreadCount).toBe(1);
        expect(plan.depth).toBe("fast");
        expect(plan.stampSource).toBe("review-body");
        expect(result.warnings.join(" ")).not.toContain("foreign");
    });

    it.each([
        ["another install", reviewBody("2.0.0", "review"), "install review"],
        ["another major", reviewBody("1.26.0", "review"), "major version 1"],
        [
            "no readable footer",
            "**Approved** — no blocking issues found.",
            "no readable",
        ],
    ])(
        "stages a first encounter when the latest review came from %s",
        async (_label, body, detail) => {
            const {fs, result, plan} = await stage(body, {
                major: 2,
                install:
                    _label === "another install" ? "review-beta" : "review",
            });
            expect(
                JSON.parse(fs.files[`${REVIEW}/prior-reviews.json`]),
            ).toEqual([]);
            expect(JSON.parse(fs.files[`${REVIEW}/threads.json`])).toEqual([]);
            expect(
                JSON.parse(fs.files[`${REVIEW}/human-threads.json`]),
            ).toEqual([{path: "a.ts", line: 3}]);
            expect(
                JSON.parse(fs.files[`${REVIEW}/adjudicated-threads.json`]).map(
                    (thread: {thread_id: string}) => thread.thread_id,
                ),
            ).toEqual(["PRRT_adjudicated"]);
            expect(JSON.parse(fs.files[`${REVIEW}/new-scope.json`])).toEqual({
                priorReview: false,
                inScope: {},
            });
            expect(result.depth).toBe("full");
            expect(plan.reasons).toEqual(["foreign-history"]);
            expect(plan.stampSource).toBeNull();
            expect(result.warnings.join(" ")).toContain(detail);
        },
    );

    it("fails closed when this run's identity is unknown", async () => {
        const {result, plan} = await stage(reviewBody("2.0.0", "review"), null);
        expect(result.depth).toBe("full");
        expect(plan.reasons).toEqual(["foreign-history"]);
    });

    it("is inert when no identity is supplied", async () => {
        const {plan} = await stage("no footer at all", undefined);
        expect(plan.reasons).not.toContain("foreign-history");
    });
});
