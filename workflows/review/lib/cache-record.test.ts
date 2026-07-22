import {describe, it, expect} from "vitest";

import {
    computeRisksPatternsKey,
    runCacheRecordCli,
    RISKS_PATTERNS_KEY_PATH,
    type CacheRecordFs,
} from "./cache-record";

/**
 * Deterministic Step 9 cache-writer tests (trial suggestion b). The record
 * is the divergence tripwire's fingerprint carrier, so the tests pin (1)
 * verbatim copying of the staged fingerprints, (2) every refusal path (on
 * doubt, the prior record must survive), and (3) the code-owned
 * risksPatternsKey / requestedTeams supplements.
 */

const REVIEW = "/tmp/gh-aw/review";
const CACHE = "/tmp/gh-aw/cache-memory";
const QUEUE = "/tmp/gh-aw/agent_output.json";
const SENTINEL = "/tmp/gh-aw/dispatch-gate.blocked";
const NOW = "2026-07-22T00:00:00.000Z";

const makeFakeFs = (
    files: Record<string, string> = {},
): CacheRecordFs & {files: Record<string, string>} => {
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
        existsSync: (p: string) => p in state,
        mkdirSync: () => {},
    };
};

const FINGERPRINT = {"a.ts": "sha-a"};
const HUNKS = {"a.ts": ["hunk-1", "hunk-2"]};
const STAMP_HUNKS = {"a.ts": ["stamp-1"]};

const staged = (over: Record<string, string> = {}): Record<string, string> => ({
    [`${REVIEW}/submission-plan.json`]: JSON.stringify({
        event: "REQUEST_CHANGES",
        comments: [{path: "a.ts", line: 2, body: "b"}],
    }),
    [`${REVIEW}/pr-context.json`]: JSON.stringify({
        number: 41,
        headSha: "abc123",
        isDraft: false,
    }),
    [`${REVIEW}/diff-facts.json`]: JSON.stringify({
        diffFingerprint: FINGERPRINT,
        hunkSignature: HUNKS,
    }),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify({
        depth: "full",
        stampHunks: STAMP_HUNKS,
    }),
    [`${REVIEW}/dispatch-result.json`]: JSON.stringify({
        claims: [
            {
                path: "a.ts",
                line: 2,
                label: "issue (blocking)",
                subject: "Broken guard.",
            },
        ],
        riskFiles: [{path: "a.ts", risk: "high"}],
    }),
    [QUEUE]: JSON.stringify({
        items: [
            {type: "submit_pull_request_review", event: "REQUEST_CHANGES"},
            {type: "create_pull_request_review_comment", path: "a.ts"},
        ],
    }),
    ...over,
});

describe("computeRisksPatternsKey", () => {
    it("builds one stable sorted string from risks, patterns, and exclusions", () => {
        const key = computeRisksPatternsKey({
            riskFiles: [
                // The contract vocabulary (review.md `files[]`: Medium/High,
                // case-insensitive), plus the tolerated "moderate" synonym.
                {path: "b.ts", risk: "Medium"},
                {path: "a.ts", risk: "high"},
                {path: "c.ts", risk: "low"},
                {path: "d.ts", risk: "moderate"},
            ],
            patterns: [
                {pattern: "rename", files: ["z.ts", "a.ts"]},
                "bump-deps",
            ],
            excludedFiles: ["gen.ts"],
            owners: {"a.ts": ["team-b", "team-a"], "b.ts": []},
        });
        expect(key).toBe(
            [
                "excluded:gen.ts",
                "pattern:bump-deps=",
                "pattern:rename=a.ts,z.ts",
                "risk:a.ts=team-a+team-b",
                "risk:b.ts=",
                "risk:d.ts=",
            ].join("|"),
        );
        // Low-risk files never contribute.
        expect(key).not.toContain("c.ts");
    });

    it("is order-insensitive on every input list", () => {
        const a = computeRisksPatternsKey({
            riskFiles: [
                {path: "a.ts", risk: "high"},
                {path: "b.ts", risk: "medium"},
            ],
            patterns: ["p1", "p2"],
            excludedFiles: ["x.ts", "y.ts"],
            owners: {},
        });
        const b = computeRisksPatternsKey({
            riskFiles: [
                {path: "b.ts", risk: "medium"},
                {path: "a.ts", risk: "high"},
            ],
            patterns: ["p2", "p1"],
            excludedFiles: ["y.ts", "x.ts"],
            owners: {},
        });
        expect(a).toBe(b);
    });

    it("is empty with nothing to report", () => {
        expect(computeRisksPatternsKey({})).toBe("");
    });
});

describe("runCacheRecordCli", () => {
    it("writes the record from staged truth, fingerprints verbatim", () => {
        const fs = makeFakeFs(staged());
        const result = runCacheRecordCli(fs, NOW);
        expect(result.written).toBe(true);
        const record = JSON.parse(fs.files[`${CACHE}/pr-41.json`]);
        expect(record).toEqual({
            timestamp: NOW,
            commitSha: "abc123",
            verdict: "REQUEST_CHANGES",
            filesReviewed: [{path: "a.ts", risk: "high"}],
            issuesFlagged: [
                {
                    path: "a.ts",
                    line: 2,
                    label: "issue (blocking)",
                    subject: "Broken guard.",
                },
            ],
            diffFingerprint: FINGERPRINT,
            reviewedHunks: HUNKS,
            stampHunks: STAMP_HUNKS,
            wasDraft: false,
        });
    });

    it("no-ops without a staged plan (task mode keeps the orchestrator's write)", () => {
        const fs = makeFakeFs();
        const result = runCacheRecordCli(fs, NOW);
        expect(result.written).toBe(false);
        expect(result.reason).toMatch(/task mode/);
        // Benign no-op: never surfaced as a workflow warning.
        expect(result.warn).toBeUndefined();
    });

    it("refuses when the gate blocked, when the queue contradicts the plan, and when diff facts are missing", () => {
        // Gate blocked: nothing posted. Benign (the gate is already loud).
        const blocked = runCacheRecordCli(
            makeFakeFs(staged({[SENTINEL]: ""})),
            NOW,
        );
        expect(blocked.written).toBe(false);
        expect(blocked.warn).toBeUndefined();
        // No submission queued for a plan with comments: a corroboration
        // mismatch, so it warns (a systematic one would permanently stale
        // the fingerprint with no UI signal otherwise).
        const notQueued = runCacheRecordCli(
            makeFakeFs(staged({[QUEUE]: JSON.stringify({items: []})})),
            NOW,
        );
        expect(notQueued.written).toBe(false);
        expect(notQueued.warn).toBe(true);
        // Queued event contradicts the plan.
        const contradicted = runCacheRecordCli(
            makeFakeFs(
                staged({
                    [QUEUE]: JSON.stringify({
                        items: [
                            {
                                type: "submit_pull_request_review",
                                event: "APPROVE",
                            },
                        ],
                    }),
                }),
            ),
            NOW,
        );
        expect(contradicted.written).toBe(false);
        expect(contradicted.warn).toBe(true);
        // Missing diff facts: a record without fingerprints poisons scoping.
        const noFacts = staged();
        delete noFacts[`${REVIEW}/diff-facts.json`];
        const missingFacts = runCacheRecordCli(makeFakeFs(noFacts), NOW);
        expect(missingFacts.written).toBe(false);
        expect(missingFacts.warn).toBe(true);
    });

    it("accepts the redundant-approval skip (APPROVE plan, zero comments, empty queue)", () => {
        const fs = makeFakeFs(
            staged({
                [`${REVIEW}/submission-plan.json`]: JSON.stringify({
                    event: "APPROVE",
                    comments: [],
                }),
                [QUEUE]: JSON.stringify({items: []}),
            }),
        );
        const result = runCacheRecordCli(fs, NOW);
        expect(result.written).toBe(true);
        expect(JSON.parse(fs.files[`${CACHE}/pr-41.json`]).verdict).toBe(
            "APPROVE",
        );
    });

    it("adopts the staged risksPatternsKey only when the guidance comment queued, else carries the prior", () => {
        const prior = JSON.stringify({
            risksPatternsKey: "prior-key",
            requestedTeams: ["team-old"],
            stampHunks: {"stale.ts": ["poisoned"]},
        });
        const withComment = makeFakeFs(
            staged({
                [`${CACHE}/pr-41.json`]: prior,
                [RISKS_PATTERNS_KEY_PATH]: "risk:a.ts=team-a\n",
                [QUEUE]: JSON.stringify({
                    items: [
                        {
                            type: "submit_pull_request_review",
                            event: "REQUEST_CHANGES",
                        },
                        {type: "add_comment", body: "guidance"},
                        {
                            type: "add_reviewer",
                            team_reviewers: ["team-new"],
                        },
                    ],
                }),
            }),
        );
        runCacheRecordCli(withComment, NOW);
        const posted = JSON.parse(withComment.files[`${CACHE}/pr-41.json`]);
        expect(posted.risksPatternsKey).toBe("risk:a.ts=team-a");
        // requestedTeams is the cumulative union, sorted.
        expect(posted.requestedTeams).toEqual(["team-new", "team-old"]);
        // The prior record's mechanical fields never leak through the merge.
        expect(posted.stampHunks).toEqual(STAMP_HUNKS);

        const withoutComment = makeFakeFs(
            staged({
                [`${CACHE}/pr-41.json`]: prior,
                [RISKS_PATTERNS_KEY_PATH]: "risk:a.ts=team-a",
            }),
        );
        runCacheRecordCli(withoutComment, NOW);
        expect(
            JSON.parse(withoutComment.files[`${CACHE}/pr-41.json`])
                .risksPatternsKey,
        ).toBe("prior-key");
    });
});

describe("the in-run safe-output queue (GH_AW_SAFE_OUTPUTS)", () => {
    const JSONL = "/tmp/runner/gh-aw/safeoutputs/outputs.jsonl";

    it("corroborates against the in-run JSONL, tolerating hyphenated types", () => {
        const base = staged();
        delete base[QUEUE];
        const fs = makeFakeFs({
            ...base,
            [JSONL]: [
                JSON.stringify({
                    type: "submit-pull-request-review",
                    event: "REQUEST_CHANGES",
                }),
                "",
            ].join("\n"),
        });
        expect(runCacheRecordCli(fs, NOW, JSONL).written).toBe(true);

        const mismatched = makeFakeFs({
            ...base,
            [JSONL]: JSON.stringify({
                type: "submit_pull_request_review",
                event: "APPROVE",
            }),
        });
        expect(runCacheRecordCli(mismatched, NOW, JSONL).written).toBe(false);
    });

    it("tolerates one malformed JSONL line without discarding the queue", () => {
        const base = staged();
        delete base[QUEUE];
        const fs = makeFakeFs({
            ...base,
            [JSONL]: [
                JSON.stringify({
                    type: "submit_pull_request_review",
                    event: "REQUEST_CHANGES",
                }),
                '{"type": "add_comm', // truncated tail from a crash mid-append
            ].join("\n"),
        });
        const result = runCacheRecordCli(fs, NOW, JSONL);
        // The intact submit line still corroborates: the queue is read as
        // readable (not fallen through to plan-only carry-forward).
        expect(result.written).toBe(true);
        expect(result.reason).not.toMatch(/queue unreadable/);
    });

    it("trusts the plan when no queue is readable, carrying the supplements forward", () => {
        const base = staged({
            [`${CACHE}/pr-41.json`]: JSON.stringify({
                risksPatternsKey: "prior-key",
            }),
            [RISKS_PATTERNS_KEY_PATH]: "new-key",
        });
        delete base[QUEUE];
        const fs = makeFakeFs(base);
        const result = runCacheRecordCli(fs, NOW);
        // The gate reds any emission that diverges from the plan, so the
        // plan alone is recorded; the staged key is NOT adopted (whether
        // the guidance comment queued is unknowable here).
        expect(result.written).toBe(true);
        expect(result.reason).toMatch(/queue unreadable/);
        const record = JSON.parse(fs.files[`${CACHE}/pr-41.json`]);
        expect(record.verdict).toBe("REQUEST_CHANGES");
        expect(record.risksPatternsKey).toBe("prior-key");
    });
});
