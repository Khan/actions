import {describe, it, expect} from "vitest";

import {computeVerdict} from "../lib/verdict";
import {loadCorpus} from "./corpus/loader";
import {stageCase, type StageFs} from "./live-stage";
import {
    computeRereviewMetrics,
    scoreRereview,
    type RereviewCaseScore,
} from "./rereview-match";
import {runCase} from "./runner";
import type {CaseRereview} from "./corpus/loader";
import type {Finding} from "../lib/finding-schema";

/* -------------------------------------------------------------------------- */
/* Fixtures: the ported lifecycle cases are the integration surface           */
/* -------------------------------------------------------------------------- */

const CORPUS = loadCorpus();
const caseById = (id: string) => {
    const found = CORPUS.find((c) => c.id === id);
    if (found === undefined) {
        throw new Error(`corpus case ${id} not found`);
    }
    return found;
};

const PUSH_2 = caseById("golden-retention-lifecycle-2");
const PUSH_3 = caseById("golden-retention-lifecycle-3");

const rereviewOf = (id: string): CaseRereview => {
    const rereview = caseById(id).live?.rereview;
    if (rereview === undefined) {
        throw new Error(`case ${id} has no rereview block`);
    }
    return rereview;
};

const findingAt = (path: string, line: number, text: string): Finding => ({
    schema_version: 2,
    id: `f-${line}`,
    lens: "correctness",
    anchor: {type: "line", path, line, side: "RIGHT"},
    severity: "advisory",
    confidence: 0.8,
    evidence_trace: [`${path}:${line}`],
    failure_scenario: text,
    producing_hunt: "test:fixture",
    model_authored_prose: text,
});

/* -------------------------------------------------------------------------- */
/* The verdict floor (the flip rule as code)                                  */
/* -------------------------------------------------------------------------- */

describe("computeVerdict: kept blocking threads", () => {
    const dimensions = {
        correctness: "assessed",
        skillSeverity: "assessed",
        patternTriage: "assessed",
    } as const;

    it("floors an otherwise-approving run at REQUEST_CHANGES", () => {
        const verdict = computeVerdict({
            postedLabels: ["suggestion (non-blocking)"],
            dimensions,
            keptBlockingCount: 2,
        });
        expect(verdict.event).toBe("REQUEST_CHANGES");
        expect(verdict.reasons).toContainEqual({
            code: "kept-blocking-thread",
            count: 2,
        });
    });

    it("does not floor when every kept thread is non-blocking", () => {
        const verdict = computeVerdict({
            postedLabels: [],
            dimensions,
            keptBlockingCount: 0,
        });
        expect(verdict.event).toBe("APPROVE");
    });
});

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

describe("scoreRereview", () => {
    const rereview = rereviewOf("golden-retention-lifecycle-2");

    it("scores a perfect reconciliation at accuracy 1 with a correct flip gate", () => {
        const score = scoreRereview(
            rereview,
            {
                resolve: ["t-purge-limit", "t-unbounded-prune"],
                keep: ["t-cap-off-by-one", "t-test-asserts-nothing"],
            },
            [],
        );
        expect(score.resolutionAccuracy).toBe(1);
        expect(score.expectedKeptBlockingCount).toBe(2);
        expect(score.actualKeptBlockingCount).toBe(2);
        expect(score.flipGateCorrect).toBe(true);
        expect(score.duplicateFindingIds).toEqual([]);
    });

    it("catches the expensive failure: resolving a kept blocking thread flips wrongly", () => {
        const score = scoreRereview(
            rereview,
            {
                resolve: [
                    "t-purge-limit",
                    "t-unbounded-prune",
                    "t-cap-off-by-one",
                    "t-test-asserts-nothing",
                ],
                keep: [],
            },
            [],
        );
        expect(score.resolutionAccuracy).toBe(0.5);
        expect(score.actualKeptBlockingCount).toBe(0);
        expect(score.flipGateCorrect).toBe(false);
    });

    it("counts unmentioned threads as missing (wrong for both expectations)", () => {
        const score = scoreRereview(rereview, undefined, []);
        expect(score.resolutions.every((r) => r.got === "missing")).toBe(true);
        expect(score.resolutionAccuracy).toBe(0);
    });

    it("flags a fresh finding that re-raises a kept thread as a duplicate", () => {
        const dup = findingAt(
            "src/notes/retention.ts",
            17,
            "The prune offset is off by one against MAX_NOTES_PER_USER.",
        );
        const fresh = findingAt(
            "src/notes/retention.ts",
            12,
            "The dedup key collides on shared prefixes.",
        );
        const score = scoreRereview(
            rereview,
            {
                resolve: ["t-purge-limit", "t-unbounded-prune"],
                keep: ["t-cap-off-by-one", "t-test-asserts-nothing"],
            },
            [dup, fresh],
        );
        expect(score.duplicateFindingIds).toEqual([dup.id]);
    });
});

describe("computeRereviewMetrics", () => {
    it("aggregates accuracy, flip-gate misses, and duplicates", () => {
        const good: RereviewCaseScore = {
            resolutions: [
                {key: "a", expect: "resolve", got: "resolve", correct: true},
            ],
            resolutionAccuracy: 1,
            expectedKeptBlockingCount: 0,
            actualKeptBlockingCount: 0,
            flipGateCorrect: true,
            duplicateFindingIds: [],
        };
        const bad: RereviewCaseScore = {
            resolutions: [
                {key: "b", expect: "keep", got: "resolve", correct: false},
            ],
            resolutionAccuracy: 0,
            expectedKeptBlockingCount: 1,
            actualKeptBlockingCount: 0,
            flipGateCorrect: false,
            duplicateFindingIds: ["dup-1"],
        };
        const metrics = computeRereviewMetrics([
            {caseId: "good", score: good},
            {caseId: "bad", score: bad},
        ]);
        expect(metrics.cases).toBe(2);
        expect(metrics.threads).toBe(2);
        expect(metrics.resolutionAccuracy).toBe(0.5);
        expect(metrics.flipGateWrongCases).toEqual(["bad"]);
        expect(metrics.duplicateComments).toBe(1);
    });
});

/* -------------------------------------------------------------------------- */
/* Staging: the open-PR state a re-review case materializes                   */
/* -------------------------------------------------------------------------- */

const memFs = (): StageFs & {files: Map<string, string>} => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
        files,
        existsSync: (p) =>
            files.has(p) ||
            dirs.has(p) ||
            [...files.keys()].some((k) => k.startsWith(`${p}/`)),
        mkdirSync: (p) => {
            dirs.add(p);
        },
        readdirSync: (p) => {
            const names = new Map<string, boolean>();
            for (const key of files.keys()) {
                if (!key.startsWith(`${p}/`)) {
                    continue;
                }
                const rest = key.slice(p.length + 1);
                const slash = rest.indexOf("/");
                if (slash === -1) {
                    names.set(rest, false);
                } else {
                    names.set(rest.slice(0, slash), true);
                }
            }
            return [...names.entries()].map(([name, isDir]) => ({
                name,
                isDirectory: () => isDir,
                isFile: () => !isDir,
            }));
        },
        readFileSync: (p) => {
            const content = files.get(p);
            if (content === undefined) {
                throw new Error(`ENOENT ${p}`);
            }
            return content;
        },
        writeFileSync: (p, data) => {
            files.set(p, data);
        },
    };
};

/** Seed the mem fs with the case's on-disk tree so stageCase can copy it. */
const seedTree = (fs: ReturnType<typeof memFs>, caseId: string): void => {
    const corpusCase = caseById(caseId);
    const caseDir = corpusCase.sourcePath.slice(
        0,
        corpusCase.sourcePath.lastIndexOf("/"),
    );
    const {readFileSync, readdirSync} =
        require("node:fs") as typeof import("node:fs");
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
            const full = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(full);
            } else {
                fs.files.set(full, readFileSync(full, "utf8"));
            }
        }
    };
    walk(`${caseDir}/tree`);
};

describe("stageCase: rereview staging", () => {
    it("stages threads, the stamped prior review, and the depth plan", () => {
        const fs = memFs();
        seedTree(fs, PUSH_2.id);
        const staged = stageCase(PUSH_2, "/stage", fs, {reReviewMode: "full"});

        const threads = JSON.parse(
            fs.files.get("/stage/context/threads.json") ?? "[]",
        ) as {thread_id: string; comments: {author: string; body: string}[]}[];
        expect(threads.map((t) => t.thread_id)).toEqual([
            "t-purge-limit",
            "t-cap-off-by-one",
            "t-unbounded-prune",
            "t-test-asserts-nothing",
        ]);
        // The author's reply rides the thread so the reconciler can weigh it.
        expect(threads[1].comments[1]?.body).toContain("Fixed the offset");

        const priorReviews = JSON.parse(
            fs.files.get("/stage/context/prior-reviews.json") ?? "[]",
        ) as {body: string}[];
        expect(priorReviews[0].body).toContain("pr-reviewer:rereview");

        expect(staged.rereviewPlan?.depth).toBe("full");
        expect(fs.files.has("/stage/context/rereview-plan.json")).toBe(true);
    });

    it("scopes the staged diff under a reduced mode (the push-2 delta only)", () => {
        const fs = memFs();
        seedTree(fs, PUSH_2.id);
        const staged = stageCase(PUSH_2, "/stage", fs, {
            reReviewMode: "scoped",
        });
        // Push 2 rewrote retention.ts and purge-user-data.ts; the test file
        // is unchanged since push 1, so a scoped staging drops it.
        const scoped = fs.files.get("/stage/context/full-stripped.diff") ?? "";
        if (staged.rereviewPlan?.depth === "scoped") {
            expect(scoped).toContain("src/notes/retention.ts");
            expect(scoped).not.toContain("retention.test.ts");
        } else {
            // 2 of 3 hunks diverged: the tripwire re-arms full instead, and
            // the staged diff stays whole. Either way the plan is recorded.
            expect(staged.rereviewPlan?.depth).toBe("full");
            expect(staged.rereviewPlan?.tripwireRearmed).toBe(true);
        }
    });

    it("stages no rereview surfaces for a plain live case", () => {
        const fs = memFs();
        seedTree(fs, "golden-retention-lifecycle-1");
        const staged = stageCase(
            caseById("golden-retention-lifecycle-1"),
            "/stage",
            fs,
            {reReviewMode: "fast"},
        );
        expect(staged.rereviewPlan).toBeUndefined();
        expect(fs.files.has("/stage/context/threads.json")).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */
/* Replay: the deterministic path over the lifecycle cases                    */
/* -------------------------------------------------------------------------- */

describe("runCase: rereview replay", () => {
    it("push 2 blocks and its body accounts for the kept threads", () => {
        const result = runCase(PUSH_2);
        expect(result.verdict.event).toBe("REQUEST_CHANGES");
        expect(result.plannedReview.body).toContain("still unaddressed");
        expect(result.plannedReview.body).toContain(
            "`src/notes/retention.ts:17`",
        );
    });

    it("push 2 still blocks with zero posted blocking comments (the floor)", () => {
        // Strip the recorded findings: the verdict must still be
        // REQUEST_CHANGES purely from the kept blocking threads.
        const result = runCase(PUSH_2, {produceFindings: () => []});
        expect(result.postedCandidates).toHaveLength(0);
        expect(result.verdict.event).toBe("REQUEST_CHANGES");
        expect(result.verdict.reasons).toContainEqual({
            code: "kept-blocking-thread",
            count: 2,
        });
    });

    it("push 3 flips to APPROVE and says every thread is resolved", () => {
        const result = runCase(PUSH_3);
        expect(result.verdict.event).toBe("APPROVE");
        expect(result.plannedReview.body).toContain(
            "All 4 prior review threads are resolved.",
        );
    });
});
