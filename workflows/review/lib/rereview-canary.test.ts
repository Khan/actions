import {describe, it, expect} from "vitest";

import {runRereviewPlanCli, runRereviewStampCli} from "./rereview-mode";

/**
 * The canary guards in the re-review machinery (split from
 * rereview-mode.test.ts by the max-lines budget). A canary run
 * (REVIEW_CANARY=1) must neither ANCHOR on production history nor WRITE
 * anything production would anchor on: both workflows post as the same bot
 * identity, so a canary stamp would be the newest parseable one in the
 * production reviewer's prior-reviews staging, and a cache record would
 * hand the canary production's fingerprint through the fallback carrier.
 */

const REVIEW_DIR = "/tmp/gh-aw/review";

const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "+added",
    " ctx",
].join("\n");

const fakeFs = (seed: Record<string, string>) => {
    const files = new Map(Object.entries(seed));
    return {
        files,
        readFileSync: (p: string) => {
            const content = files.get(p);
            if (content === undefined) {
                throw new Error(`ENOENT: ${p}`);
            }
            return content;
        },
        writeFileSync: (p: string, data: string) => void files.set(p, data),
        existsSync: (p: string) => files.has(p),
        mkdirSync: () => undefined,
    };
};

const staging = (over: Record<string, string> = {}) =>
    fakeFs({
        [`${REVIEW_DIR}/full.diff`]: DIFF,
        [`${REVIEW_DIR}/routing.json`]: JSON.stringify({reReviewMode: "fast"}),
        [`${REVIEW_DIR}/pr-context.json`]: JSON.stringify({
            isDraft: false,
            number: 7,
        }),
        [`${REVIEW_DIR}/prior-reviews.json`]: "[]",
        ...over,
    });

describe("canary guards (REVIEW_CANARY=1)", () => {
    it("the plan never anchors on the cache record (the knob must not depend on the canary workflow disabling cache memory)", () => {
        const record = JSON.stringify({
            verdict: "APPROVE",
            reviewedHunks: {"a.ts": ["deadbeef00000000"]},
            wasDraft: false,
        });
        const cachePath = "/tmp/gh-aw/cache-memory/pr-7.json";
        // Control: a production run anchors on this exact record.
        const production = runRereviewPlanCli(
            staging({[cachePath]: record}),
            "pull_request",
            undefined,
            false,
        );
        expect(production.stampSource).toBe("cache-memory");
        // The canary run does not.
        const canary = runRereviewPlanCli(
            staging({[cachePath]: record}),
            "pull_request",
            undefined,
            true,
        );
        expect(canary.plan.depth).toBe("full");
        expect(canary.plan.reasons).toEqual(["no-prior-fingerprint"]);
        expect(canary.stampSource).toBeNull();
    });

    it("the stamp is never emitted (production would anchor its next round on it)", () => {
        const fs = staging();
        runRereviewPlanCli(fs, "pull_request", undefined, true);
        // Control: the same staged plan renders a stamp off canary.
        expect(runRereviewStampCli(fs, "APPROVE", false)).not.toBeNull();
        expect(runRereviewStampCli(fs, "APPROVE", true)).toBeNull();
    });
});
