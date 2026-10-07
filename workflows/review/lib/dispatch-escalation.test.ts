import {describe, it, expect} from "vitest";

import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import {
    CLEARANCE_ESCALATION_REASON,
    everyBlockingThreadResolved,
} from "./dispatch-escalation";
import {computeDiffProvenance} from "./provenance";
import {
    computeHunkSignature,
    parseRereviewStamp,
    renderRereviewStampLine,
    runRereviewStampCli,
} from "./rereview-mode";

const REVIEW = "/tmp/gh-aw/review";
const AGENTS = "/work/.claude/agents";

const makeFakeFs = (
    files: Record<string, string>,
): DispatchFs & {
    files: Record<string, string>;
    rmSync: (p: string) => void;
} => {
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
        readdirSync: (p: string) => [
            ...new Set(
                Object.keys(state)
                    .filter((f) => f.startsWith(`${p}/`))
                    .map((f) => f.slice(p.length + 1).split("/")[0]),
            ),
        ],
        rmSync: (p: string) => {
            delete state[p];
        },
    };
};

const AGENT_NAMES = [
    "thread-reconciler",
    "pattern-triage",
    "correctness-reviewer",
    "skill-auditor",
    "claim-validator",
];

const stubRunner = (
    outputs: Record<string, string>,
    fail: string[] = [],
): AgentRunner & {calls: string[]} => {
    const calls: string[] = [];
    const runner = (async (request) => {
        calls.push(request.name);
        if (fail.includes(request.name)) {
            throw new Error("boom");
        }
        const output = outputs[request.name];
        if (output === undefined) {
            throw new Error(`no canned output for ${request.name}`);
        }
        return {output, usd: 0.5, turns: 3, wallMs: 100};
    }) as AgentRunner & {calls: string[]};
    runner.calls = calls;
    return runner;
};

const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "+fixed line",
    " ctx",
    "",
].join("\n");

const OLD_ANCHOR = {"a.ts": ["deadbeef00000000"]};

const stamped = (verdict: string): string =>
    `review body\n${renderRereviewStampLine({
        schemaVersion: 1,
        depth: "full",
        verdict,
        anchorDraft: false,
        anchorHunks: OLD_ANCHOR,
    })}`;

const thread = (id: string, label: string): Record<string, unknown> => ({
    thread_id: id,
    path: "a.ts",
    line: 2,
    resolved: false,
    comments: [{author: "github-actions[bot]", body: `**${label}:** x`}],
});

const FAST_PLAN = {
    mode: "fast",
    depth: "fast",
    dispatch: "reconcile-only",
    staging: "none",
    flipGate: false,
    reasons: ["mode-fast"],
    divergence: null,
    tripwireRearmed: false,
    stampHunks: OLD_ANCHOR,
    stampAnchorDraft: false,
};

/** A fast round over a standing REQUEST_CHANGES with one blocking thread. */
const staging = (
    overrides: {
        isDraft?: boolean;
        priorVerdict?: string;
        priorState?: string;
    } = {},
): Record<string, string> => ({
    ...Object.fromEntries(
        AGENT_NAMES.map((name) => [
            `${AGENTS}/${name}.md`,
            `---\nname: ${name}\ndescription: d\nmodel: claude-opus-5-5\n---\nYou are ${name}.`,
        ]),
    ),
    [`${REVIEW}/routing.json`]: JSON.stringify({
        enabledReviewers: [],
        lensesToSpawn: [],
        runBudget: {maxReviewerInvocations: 6, tier: "High"},
    }),
    [`${REVIEW}/rereview-plan.json`]: JSON.stringify(FAST_PLAN),
    [`${REVIEW}/out/rereview-plan.json`]: JSON.stringify(FAST_PLAN),
    [`${REVIEW}/full.diff`]: DIFF,
    [`${REVIEW}/full-stripped.diff`]: DIFF,
    [`${REVIEW}/files.json`]: JSON.stringify([
        {path: "a.ts", status: "modified", hasPatch: true},
    ]),
    [`${REVIEW}/provenance.json`]: JSON.stringify(computeDiffProvenance(DIFF)),
    [`${REVIEW}/pr-context.json`]: JSON.stringify({
        number: 7,
        isDraft: overrides.isDraft ?? false,
    }),
    [`${REVIEW}/prior-reviews.json`]: JSON.stringify([
        {
            body: stamped(overrides.priorVerdict ?? "REQUEST_CHANGES"),
            id: 3001,
            state: overrides.priorState ?? "CHANGES_REQUESTED",
            submittedAt: "2026-10-01T00:00:00Z",
        },
    ]),
    [`${REVIEW}/threads.json`]: JSON.stringify([
        thread("t1", "issue (blocking)"),
        thread("t2", "suggestion (non-blocking)"),
    ]),
});

const outputs = (
    reconciler: Record<string, unknown>,
): Record<string, string> => ({
    "thread-reconciler": JSON.stringify(reconciler),
    "pattern-triage": JSON.stringify({patterns: [], reviewFiles: ["a.ts"]}),
    "correctness-reviewer": JSON.stringify({
        findings: [],
        files: [{path: "a.ts", risk: "medium"}],
    }),
    "skill-auditor": JSON.stringify({findings: []}),
});

const CLEARED = {resolve: ["t1"], keep: ["t2"]};

const run = async (
    fs: DispatchFs,
    runner: AgentRunner,
    canary = false,
): ReturnType<typeof runDispatch> =>
    runDispatch({fs, runner, repoRoot: "/work", canary});

describe("the clearance escalation", () => {
    it("continues a cleared fast round as a full round, reconciling once", async () => {
        const fs = makeFakeFs(staging());
        const runner = stubRunner(outputs(CLEARED));
        const result = await run(fs, runner);

        expect(result.depth).toBe("full");
        expect(result.escalatedFrom).toBe("fast");
        expect(result.reconciliation?.resolve).toEqual(["t1"]);
        expect(
            runner.calls.filter((n) => n === "thread-reconciler"),
        ).toHaveLength(1);
        expect(runner.calls[0]).toBe("thread-reconciler");
        expect(runner.calls).toEqual(
            expect.arrayContaining([
                "pattern-triage",
                "correctness-reviewer",
                "skill-auditor",
            ]),
        );
        expect(result.riskFiles).toEqual([{path: "a.ts", risk: "medium"}]);

        for (const path of [
            `${REVIEW}/rereview-plan.json`,
            `${REVIEW}/out/rereview-plan.json`,
        ]) {
            const plan = JSON.parse(fs.files[path]);
            expect(plan).toMatchObject({
                mode: "fast",
                depth: "full",
                dispatch: "all",
                staging: "whole-diff",
                escalatedFrom: "fast",
                reasons: ["mode-fast", CLEARANCE_ESCALATION_REASON],
                stampHunks: computeHunkSignature(DIFF),
                stampAnchorDraft: false,
            });
        }
    });

    it("stamps the escalated round as full, anchored on the current diff", async () => {
        const fs = makeFakeFs(staging());
        await run(fs, stubRunner(outputs(CLEARED)));
        const line = runRereviewStampCli(fs, "APPROVE", false);
        expect(line).not.toBeNull();
        expect(parseRereviewStamp(line ?? "")).toMatchObject({
            depth: "full",
            verdict: "APPROVE",
            anchorHunks: computeHunkSignature(DIFF),
        });
    });

    it("stays fast while a blocking thread is kept", async () => {
        const fs = makeFakeFs(staging());
        const runner = stubRunner(outputs({resolve: [], keep: ["t1", "t2"]}));
        const result = await run(fs, runner);
        expect(result.depth).toBe("fast");
        expect(result.escalatedFrom).toBeUndefined();
        expect(runner.calls).toEqual(["thread-reconciler"]);
        expect(JSON.parse(fs.files[`${REVIEW}/rereview-plan.json`])).toEqual(
            FAST_PLAN,
        );
    });

    it("stays fast when the reconciler leaves a blocking thread out of both lists", async () => {
        const fs = makeFakeFs(staging());
        const runner = stubRunner(outputs({resolve: ["t2"], keep: []}));
        const result = await run(fs, runner);
        expect(result.depth).toBe("fast");
        expect(runner.calls).toEqual(["thread-reconciler"]);
    });

    it("stays fast, and discloses the gap, when the reconciler fails", async () => {
        const fs = makeFakeFs(staging());
        const runner = stubRunner(outputs(CLEARED), ["thread-reconciler"]);
        const result = await run(fs, runner);
        expect(result.depth).toBe("fast");
        expect(result.reconciliation).toBeUndefined();
        expect(result.skippedDimensions).toContainEqual({
            dimension: "thread reconciliation",
            cause: "unavailable",
        });
        expect(runner.calls).toEqual(["thread-reconciler"]);
    });

    it.each([
        ["a draft", {isDraft: true}, false],
        [
            "a PR with no standing block",
            {priorVerdict: "APPROVE", priorState: "APPROVED"},
            false,
        ],
        ["a canary run", {}, true],
    ])("never escalates on %s", async (_name, overrides, canary) => {
        const fs = makeFakeFs(staging(overrides));
        const runner = stubRunner(outputs(CLEARED));
        const result = await run(fs, runner, canary);
        expect(result.depth).toBe("fast");
        expect(result.escalatedFrom).toBeUndefined();
        expect(runner.calls).toEqual(["thread-reconciler"]);
    });

    it("escalates when the stamp moved on but the block still stands live", async () => {
        const staged = staging();
        staged[`${REVIEW}/prior-reviews.json`] = JSON.stringify([
            {
                body: stamped("REQUEST_CHANGES"),
                id: 3001,
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-10-01T00:00:00Z",
            },
            {
                body: stamped("COMMENT"),
                id: 3002,
                state: "COMMENTED",
                submittedAt: "2026-10-02T00:00:00Z",
            },
        ]);
        const result = await run(
            makeFakeFs(staged),
            stubRunner(outputs(CLEARED)),
        );
        expect(result.escalatedFrom).toBe("fast");
    });

    it("never escalates a round planned at full or scoped depth", async () => {
        const staged = staging();
        staged[`${REVIEW}/rereview-plan.json`] = JSON.stringify({
            ...FAST_PLAN,
            depth: "full",
        });
        const runner = stubRunner(outputs(CLEARED));
        const result = await run(makeFakeFs(staged), runner);
        expect(result.escalatedFrom).toBeUndefined();
        expect(runner.calls[0]).toBe("pattern-triage");
    });

    it("falls back to the fast round when the escalated round loses a core reviewer", async () => {
        const fs = makeFakeFs(staging());
        const runner = stubRunner(outputs(CLEARED), ["correctness-reviewer"]);
        const result = await run(fs, runner);

        expect(result.depth).toBe("fast");
        expect(result.escalatedFrom).toBe("fast");
        expect(result.escalationFellBack).toEqual(["correctness-reviewer"]);
        expect(result.skippedDimensions).toEqual([]);
        expect(result.reconciliation?.resolve).toEqual(["t1"]);
        expect(result.noteLines).toContain(
            "Note: the full round to decide approval lost its correctness-reviewer output, so this re-review stayed at fast depth.",
        );
        for (const path of [
            `${REVIEW}/rereview-plan.json`,
            `${REVIEW}/out/rereview-plan.json`,
        ]) {
            expect(JSON.parse(fs.files[path])).toEqual(FAST_PLAN);
        }
    });

    it("records the escalated roster's budget sheds", async () => {
        const staged = staging();
        staged[`${REVIEW}/routing.json`] = JSON.stringify({
            enabledReviewers: ["holistic"],
            lensesToSpawn: [],
            runBudget: {maxReviewerInvocations: 2, tier: "Low"},
        });
        const result = await run(
            makeFakeFs(staged),
            stubRunner(outputs(CLEARED)),
        );
        expect(result.depth).toBe("full");
        expect(result.skippedDimensions).toContainEqual({
            dimension: "holistic",
            cause: "budget",
        });
    });
});

describe("everyBlockingThreadResolved: the fail-closed rule", () => {
    const opened = (body: unknown): unknown[] => [
        {thread_id: "t1", comments: [{author: "github-actions[bot]", body}]},
    ];

    it("counts a thread whose opener label does not parse as blocking", () => {
        expect(
            everyBlockingThreadResolved(opened("Plain reply text."), []),
        ).toBe(false);
        expect(
            everyBlockingThreadResolved(opened("Plain reply text."), ["t1"]),
        ).toBe(true);
    });

    it("counts a thread with no usable opener as blocking", () => {
        expect(
            everyBlockingThreadResolved([{thread_id: "t1", comments: []}], []),
        ).toBe(false);
        expect(everyBlockingThreadResolved(opened(42), [])).toBe(false);
    });

    it("never clears a thread it cannot identify", () => {
        expect(everyBlockingThreadResolved([{comments: []}], ["t1"])).toBe(
            false,
        );
        expect(everyBlockingThreadResolved(["not-a-thread"], ["t1"])).toBe(
            false,
        );
    });

    it("leaves a parsed non-blocking thread out of the requirement", () => {
        expect(
            everyBlockingThreadResolved(
                opened("**suggestion (non-blocking):** x"),
                [],
            ),
        ).toBe(true);
    });
});
