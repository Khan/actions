import {describe, it, expect} from "vitest";

import {renderRereviewStamp} from "./rereview-mode";
import {
    prCoordinatesFromEnv,
    runDismissReviewCli,
    type DismissGet,
    type DismissPut,
    type DismissReviewFs,
} from "./dismiss-review";
import {DISMISSAL_MESSAGE} from "./submission-clearance";

/**
 * The reduced-depth clearance's executor: the plan CLI stages the decision
 * (`out/dismiss-decision.json`, submission.ts), this CLI executes it via
 * the dismissals API. Nothing staged feeds the write path: the allowlist
 * is fetched live (`GET /pulls/{n}/reviews`) and scoped to reviews whose
 * body carries this workflow's own re-review stamp, the coordinates come
 * from the runner's env, and every failure is a warning (the block stands:
 * more review, never less). No decision file is the common no-op case.
 */

const REVIEW = "/tmp/gh-aw/review";
const COORDS = {repo: "Khan/webapp", prNumber: 41007};
const REVIEWS_PATH_PAGE_1 =
    "/repos/Khan/webapp/pulls/41007/reviews?per_page=100&page=1";

const makeFakeFs = (files: Record<string, string> = {}): DismissReviewFs => ({
    readFileSync: (p: string) => {
        if (!(p in files)) {
            throw new Error(`ENOENT: ${p}`);
        }
        return files[p];
    },
    existsSync: (p: string) => p in files,
});

/** A review body carrying this workflow's stamp (the identity marker). */
const stampedBody = (verdict: string, head = "review body"): string =>
    `${head}\n${renderRereviewStamp({
        schemaVersion: 1,
        depth: "full",
        verdict,
        anchorDraft: false,
        anchorHunks: {"a.ts": ["deadbeef00000000"]},
    })}`;

/** The live review list a clean clearance round sees. */
const liveReviews = (): unknown[] => [
    {
        id: 3001,
        state: "CHANGES_REQUESTED",
        body: stampedBody("REQUEST_CHANGES", "r1"),
        user: {login: "github-actions[bot]"},
    },
    {
        id: 3002,
        state: "COMMENTED",
        body: "a foreign workflow's comment",
        user: {login: "github-actions[bot]"},
    },
    {
        id: 3003,
        state: "CHANGES_REQUESTED",
        body: stampedBody("REQUEST_CHANGES", "r3"),
        user: {login: "github-actions[bot]"},
    },
];

const stagedDecision = (
    reviewIds: unknown = [3001],
    message: string = DISMISSAL_MESSAGE,
): Record<string, string> => ({
    [`${REVIEW}/out/dismiss-decision.json`]: JSON.stringify({
        reviewIds,
        message,
    }),
});

const recordingGet = (
    reviews: unknown[] = liveReviews(),
): {get: DismissGet; paths: string[]} => {
    const paths: string[] = [];
    return {
        paths,
        get: async (path) => {
            paths.push(path);
            return {ok: true, status: 200, body: reviews};
        },
    };
};

const recordingPut = (
    responses: Record<string, {ok: boolean; status: number}> = {},
): {put: DismissPut; calls: {path: string; message: string}[]} => {
    const calls: {path: string; message: string}[] = [];
    return {
        calls,
        put: async (path, body) => {
            calls.push({path, message: body.message});
            return responses[path] ?? {ok: true, status: 200};
        },
    };
};

describe("prCoordinatesFromEnv", () => {
    const eventFs = (payload: unknown): DismissReviewFs =>
        makeFakeFs({"/tmp/event.json": JSON.stringify(payload)});

    it("prefers the expression-expanded REVIEW_PR_NUMBER env", () => {
        expect(
            prCoordinatesFromEnv(
                eventFs({pull_request: {number: 99}}),
                "Khan/webapp",
                "41007",
                "/tmp/event.json",
            ),
        ).toEqual({repo: "Khan/webapp", prNumber: 41007});
    });

    it("falls back to the event payload (pull_request, then issue)", () => {
        // "" rather than undefined throughout: an undefined argument
        // re-enables the process.env default, which is populated on a CI
        // runner (GITHUB_REPOSITORY et al) and empty locally.
        expect(
            prCoordinatesFromEnv(
                eventFs({pull_request: {number: 41007}}),
                "Khan/webapp",
                "",
                "/tmp/event.json",
            ),
        ).toEqual({repo: "Khan/webapp", prNumber: 41007});
        expect(
            prCoordinatesFromEnv(
                eventFs({issue: {number: 41007}}),
                "Khan/webapp",
                "",
                "/tmp/event.json",
            ),
        ).toEqual({repo: "Khan/webapp", prNumber: 41007});
    });

    it("returns null without a repository or a usable number", () => {
        expect(
            prCoordinatesFromEnv(
                eventFs({pull_request: {number: 41007}}),
                "",
                "41007",
                "/tmp/event.json",
            ),
        ).toBe(null);
        expect(
            prCoordinatesFromEnv(
                eventFs({}),
                "Khan/webapp",
                "not-a-number",
                "/tmp/event.json",
            ),
        ).toBe(null);
        expect(
            prCoordinatesFromEnv(makeFakeFs({}), "Khan/webapp", "", ""),
        ).toBe(null);
    });
});

describe("runDismissReviewCli", () => {
    it("dismisses each staged review id with the shared message", async () => {
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001, 3003])),
            put,
            recordingGet().get,
            COORDS,
        );
        expect(result.dismissed).toEqual([3001, 3003]);
        expect(result.warnings).toEqual([]);
        expect(calls).toEqual([
            {
                path: "/repos/Khan/webapp/pulls/41007/reviews/3001/dismissals",
                message: DISMISSAL_MESSAGE,
            },
            {
                path: "/repos/Khan/webapp/pulls/41007/reviews/3003/dismissals",
                message: DISMISSAL_MESSAGE,
            },
        ]);
    });

    it("is a no-op when no decision is staged (every full/scoped round)", async () => {
        const {put, calls} = recordingPut();
        const {get, paths} = recordingGet();
        const result = await runDismissReviewCli(
            makeFakeFs({}),
            put,
            get,
            COORDS,
        );
        expect(result).toEqual({dismissed: [], warnings: []});
        expect(calls).toEqual([]);
        // Not even the list fetch: nothing to check a decision against.
        expect(paths).toEqual([]);
    });

    it("warns and dismisses nothing on an unusable decision", async () => {
        for (const files of [
            stagedDecision([]),
            stagedDecision(["not-a-number"]),
            stagedDecision([3001], ""),
            // The message half of the gate's rule 5c, mirrored here for
            // the gate's fail-open path: only the shared constant posts.
            stagedDecision([3001], "drifted justification"),
            {[`${REVIEW}/out/dismiss-decision.json`]: "not json"},
            // JSON.parse("null") parses fine; member access on it must
            // warn as unusable, not throw.
            {[`${REVIEW}/out/dismiss-decision.json`]: "null"},
        ]) {
            const {put, calls} = recordingPut();
            const result = await runDismissReviewCli(
                makeFakeFs(files),
                put,
                recordingGet().get,
                COORDS,
            );
            expect(result.dismissed).toEqual([]);
            expect(calls).toEqual([]);
            expect(result.warnings.join(" ")).toContain("block stands");
        }
    });

    it("refuses ids that are not this workflow's standing blocks and keeps the rest", async () => {
        // 3002 carries no stamp (a foreign workflow shares the login,
        // never the stamp) and 9999 is unknown: neither may dismiss,
        // whatever the agent-writable decision file says. 3001 stands.
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001, 3002, 9999])),
            put,
            recordingGet().get,
            COORDS,
        );
        expect(result.dismissed).toEqual([3001]);
        expect(calls.map((call) => call.path)).toEqual([
            "/repos/Khan/webapp/pulls/41007/reviews/3001/dismissals",
        ]);
        expect(result.warnings).toEqual([
            "dismissal of review 3002 refused: not one of this workflow's standing CHANGES_REQUESTED reviews",
            "dismissal of review 9999 refused: not one of this workflow's standing CHANGES_REQUESTED reviews",
        ]);
    });

    it("refuses an id a later stamped APPROVED superseded (not standing)", async () => {
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001])),
            put,
            recordingGet([
                {
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                    body: stampedBody("REQUEST_CHANGES", "r1"),
                    user: {login: "github-actions[bot]"},
                },
                {
                    id: 3005,
                    state: "APPROVED",
                    body: stampedBody("APPROVE"),
                    user: {login: "github-actions[bot]"},
                },
            ]).get,
            COORDS,
        );
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain("refused");
    });

    it("refuses a human review carrying a copied stamp (author and stamp intersect)", async () => {
        // The stamp posts verbatim in every bot review body, so it is
        // public and copyable; a review that is not the bot's must never
        // become dismissable, stamp or no stamp.
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([4001])),
            put,
            recordingGet([
                {
                    id: 4001,
                    state: "CHANGES_REQUESTED",
                    body: stampedBody("REQUEST_CHANGES", "copied"),
                    user: {login: "some-human"},
                },
            ]).get,
            COORDS,
        );
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain("refused");
    });

    it("pages through the review list (the standing block can sit past page 1)", async () => {
        // 100 filler reviews on page 1 (a review per push adds up), the
        // standing block on page 2: the allowlist must span every page.
        const pages: unknown[][] = [
            Array.from({length: 100}, (_, i) => ({
                id: i + 1,
                state: "COMMENTED",
                body: "filler",
                user: {login: "github-actions[bot]"},
            })),
            [
                {
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                    body: stampedBody("REQUEST_CHANGES", "r1"),
                    user: {login: "github-actions[bot]"},
                },
            ],
        ];
        const paths: string[] = [];
        const get: DismissGet = async (path) => {
            paths.push(path);
            return {ok: true, status: 200, body: pages[paths.length - 1]};
        };
        const {put} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001])),
            put,
            get,
            COORDS,
        );
        expect(paths).toHaveLength(2);
        expect(result.dismissed).toEqual([3001]);
    });

    it("refuses on a non-array page (a lying API is a failed fetch)", async () => {
        const get: DismissGet = async () => ({
            ok: true,
            status: 200,
            body: {message: "not a list"},
        });
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001])),
            put,
            get,
            COORDS,
        );
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain(
            "standing-review fetch failed",
        );
    });

    it("fetches the allowlist live, never from staged JSON", async () => {
        const {put} = recordingPut();
        const {get, paths} = recordingGet();
        await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001])),
            put,
            get,
            COORDS,
        );
        expect(paths).toEqual([REVIEWS_PATH_PAGE_1]);
    });

    it("dismisses nothing when the live fetch fails (block stands)", async () => {
        const {put, calls} = recordingPut();
        for (const get of [
            (async () => ({
                ok: false,
                status: 502,
                body: undefined,
            })) as DismissGet,
            (async () => {
                throw new Error("ECONNRESET");
            }) as DismissGet,
        ]) {
            const result = await runDismissReviewCli(
                makeFakeFs(stagedDecision([3001])),
                put,
                get,
                COORDS,
            );
            expect(result.dismissed).toEqual([]);
            expect(result.warnings.join(" ")).toContain(
                "standing-review fetch failed",
            );
        }
        expect(calls).toEqual([]);
    });

    it("warns when the pr coordinates are unavailable (block stands)", async () => {
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision()),
            put,
            recordingGet().get,
            null,
        );
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain(
            "pr coordinates unavailable",
        );
    });

    it("warns per failed dismissal and keeps going (an HTTP error never reds the run)", async () => {
        const {put} = recordingPut({
            "/repos/Khan/webapp/pulls/41007/reviews/3001/dismissals": {
                ok: false,
                status: 422,
            },
        });
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001, 3003])),
            put,
            recordingGet().get,
            COORDS,
        );
        expect(result.dismissed).toEqual([3003]);
        expect(result.warnings).toEqual([
            "dismissal of review 3001 failed (HTTP 422): block stands",
        ]);
    });

    it("a human APPROVED with a copied stamp does not supersede the bot's standing block", async () => {
        // The bot-author filter applies before the latest-decisive-wins
        // reduction, so a foreign APPROVED cannot reset the bot's standing
        // CHANGES_REQUESTED out of the allowlist (or, worse, out of
        // priorRcStands).
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001])),
            put,
            recordingGet([
                {
                    id: 3001,
                    state: "CHANGES_REQUESTED",
                    body: stampedBody("REQUEST_CHANGES", "r1"),
                    user: {login: "github-actions[bot]"},
                },
                {
                    id: 4001,
                    state: "APPROVED",
                    body: stampedBody("APPROVE", "copied"),
                    user: {login: "some-human"},
                },
            ]).get,
            COORDS,
        );
        expect(result.dismissed).toEqual([3001]);
        expect(calls.map((call) => call.path)).toEqual([
            "/repos/Khan/webapp/pulls/41007/reviews/3001/dismissals",
        ]);
    });

    it("treats a thrown fetch as a warning too", async () => {
        const put: DismissPut = async () => {
            throw new Error("ECONNRESET");
        };
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision()),
            put,
            recordingGet().get,
            COORDS,
        );
        expect(result.dismissed).toEqual([]);
        expect(result.warnings).toEqual([
            "dismissal of review 3001 failed (ECONNRESET): block stands",
        ]);
    });
});
