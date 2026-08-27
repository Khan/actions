import {describe, it, expect} from "vitest";

import {
    runDismissReviewCli,
    type DismissPut,
    type DismissReviewFs,
} from "./dismiss-review";
import {DISMISSAL_MESSAGE} from "./submission-clearance";

/**
 * The reduced-depth clearance's executor: the plan CLI stages the decision
 * (`out/dismiss-decision.json`, submission.ts), this CLI executes it via
 * the dismissals API. Every failure is a warning (the block stands: more
 * review, never less), and no decision file is the common no-op case.
 */

const REVIEW = "/tmp/gh-aw/review";

const makeFakeFs = (files: Record<string, string> = {}): DismissReviewFs => ({
    readFileSync: (p: string) => {
        if (!(p in files)) {
            throw new Error(`ENOENT: ${p}`);
        }
        return files[p];
    },
    existsSync: (p: string) => p in files,
});

const stagedDecision = (
    reviewIds: unknown = [3001],
    message: string = DISMISSAL_MESSAGE,
): Record<string, string> => ({
    [`${REVIEW}/out/dismiss-decision.json`]: JSON.stringify({
        reviewIds,
        message,
    }),
    [`${REVIEW}/pr-context.json`]: JSON.stringify({
        number: 41007,
        repo: "Khan/webapp",
    }),
    // The executor's id allowlist: only CHANGES_REQUESTED entries here
    // may dismiss (the decision file itself is agent-writable).
    [`${REVIEW}/prior-reviews.json`]: JSON.stringify([
        {body: "r1", id: 3001, state: "CHANGES_REQUESTED"},
        {body: "r2", id: 3002, state: "COMMENTED"},
        {body: "r3", id: 3003, state: "CHANGES_REQUESTED"},
    ]),
});

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

describe("runDismissReviewCli", () => {
    it("dismisses each staged review id with the staged message", async () => {
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001, 3003])),
            put,
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
        const result = await runDismissReviewCli(makeFakeFs({}), put);
        expect(result).toEqual({dismissed: [], warnings: []});
        expect(calls).toEqual([]);
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
        ]) {
            const {put, calls} = recordingPut();
            const result = await runDismissReviewCli(makeFakeFs(files), put);
            expect(result.dismissed).toEqual([]);
            expect(calls).toEqual([]);
            // A present-but-unusable decision always warns, unparseable
            // included: the failure posture is a warning, never silence.
            expect(result.warnings.join(" ")).toContain("block stands");
        }
    });

    it("refuses ids that are not standing CHANGES_REQUESTED reviews and keeps the rest", async () => {
        // 3002 is COMMENTED and 9999 is unknown: neither may dismiss,
        // whatever the agent-writable decision file says. 3001 stands.
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision([3001, 3002, 9999])),
            put,
        );
        expect(result.dismissed).toEqual([3001]);
        expect(calls.map((call) => call.path)).toEqual([
            "/repos/Khan/webapp/pulls/41007/reviews/3001/dismissals",
        ]);
        expect(result.warnings).toEqual([
            `dismissal of review 3002 refused: not a CHANGES_REQUESTED id in ${REVIEW}/prior-reviews.json`,
            `dismissal of review 9999 refused: not a CHANGES_REQUESTED id in ${REVIEW}/prior-reviews.json`,
        ]);
    });

    it("refuses an id a later APPROVED superseded (not standing)", async () => {
        const files = stagedDecision([3001]);
        files[`${REVIEW}/prior-reviews.json`] = JSON.stringify([
            {body: "r1", id: 3001, state: "CHANGES_REQUESTED"},
            {body: "r2", id: 3005, state: "APPROVED"},
        ]);
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(makeFakeFs(files), put);
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain("refused");
    });

    it("refuses every id when prior-reviews.json is not staged (block stands)", async () => {
        const files = stagedDecision([3001]);
        delete files[`${REVIEW}/prior-reviews.json`];
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(makeFakeFs(files), put);
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain("refused");
    });

    it("warns when pr-context is missing (block stands)", async () => {
        const files = stagedDecision();
        delete files[`${REVIEW}/pr-context.json`];
        const {put, calls} = recordingPut();
        const result = await runDismissReviewCli(makeFakeFs(files), put);
        expect(result.dismissed).toEqual([]);
        expect(calls).toEqual([]);
        expect(result.warnings.join(" ")).toContain("pr context not staged");
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
        );
        expect(result.dismissed).toEqual([3003]);
        expect(result.warnings).toEqual([
            "dismissal of review 3001 failed (HTTP 422): block stands",
        ]);
    });

    it("treats a thrown fetch as a warning too", async () => {
        const put: DismissPut = async () => {
            throw new Error("ECONNRESET");
        };
        const result = await runDismissReviewCli(
            makeFakeFs(stagedDecision()),
            put,
        );
        expect(result.dismissed).toEqual([]);
        expect(result.warnings).toEqual([
            "dismissal of review 3001 failed (ECONNRESET): block stands",
        ]);
    });
});
