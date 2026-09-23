import {describe, expect, it} from "vitest";

import {runCacheRecordCli} from "./cache-record";
import {suppressTrackedDuplicates} from "./dedup-adjudicated";
import {openThreadScore, openThreadsFromStaged} from "./dedup-threads";
import {runDispatch, type AgentRunner, type DispatchFs} from "./dispatch";
import fixture from "./fixtures/answered-scope-42048.json";
import {runStagePrCli} from "./stage-pr";
import {runSubmissionCli} from "./submission";

const REVIEW = "/tmp/gh-aw/review";
const CACHE = "/tmp/gh-aw/cache-memory/pr-42048.json";
const QUESTION = fixture.thread;
const PATH = QUESTION.path;
const FIXED = "PRRT_fixed_defect";
const DEFECT = {
    path: "defect.ts",
    line: 2,
    label: "suggestion (non-blocking)",
    subject: "Expired memories are identified but never deleted.",
    discussion:
        "The expiration path identifies expired memories but skips deletion, leaving every expired memory in storage.",
    failure_scenario:
        "Every expiration sweep identifies expired memories but skips deletion, so storage grows forever.",
};

const fakeFs = (
    initial: Record<string, string> = {},
): DispatchFs & {files: Record<string, string>} => {
    const files = {...initial};
    return {
        files,
        readFileSync: (path) => {
            if (!(path in files)) {
                throw new Error(`ENOENT: ${path}`);
            }
            return files[path];
        },
        writeFileSync: (path, data) => {
            files[path] = data;
        },
        existsSync: (path) =>
            path in files ||
            Object.keys(files).some((p) => p.startsWith(`${path}/`)),
        mkdirSync: () => {},
        readdirSync: (path) =>
            Object.keys(files)
                .filter((p) => p.startsWith(`${path}/`))
                .map((p) => p.slice(path.length + 1)),
    };
};

const stage = async (
    fs: ReturnType<typeof fakeFs>,
    resolved: boolean,
    defectLabel: string,
    canary = false,
) => {
    await runStagePrCli(
        fs,
        async (path) => {
            if (path.endsWith("/pulls/42048")) {
                return {
                    number: 42048,
                    title: "Consumer switch",
                    user: {login: "Bcdirito"},
                    head: {sha: "abcdef1"},
                    base: {ref: "main"},
                };
            }
            if (path.includes("/files?")) {
                return [
                    {
                        filename: PATH,
                        status: "modified",
                        patch: `@@ -475,0 +475,1 @@\n+query ${
                            resolved ? "revised" : "initial"
                        }`,
                    },
                    {
                        filename: "defect.ts",
                        status: "modified",
                        patch: `@@ -1,1 +1,2 @@\n context\n+regression ${
                            resolved ? "restored" : "initial"
                        }`,
                    },
                ];
            }
            if (path.includes("/reviews?")) {
                return [];
            }
            throw new Error(`Unexpected route: ${path}`);
        },
        async () => ({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            pageInfo: {hasNextPage: false},
                            nodes: [
                                {
                                    ...QUESTION,
                                    id: QUESTION.thread_id,
                                    isResolved: resolved,
                                    resolvedBy: resolved
                                        ? {login: "github-actions"}
                                        : null,
                                    comments: {
                                        nodes: QUESTION.comments.map(
                                            (comment) => ({
                                                ...comment,
                                                author: {login: comment.author},
                                            }),
                                        ),
                                    },
                                },
                                {
                                    id: FIXED,
                                    path: "defect.ts",
                                    line: 2,
                                    isResolved: resolved,
                                    resolvedBy: resolved
                                        ? {login: "github-actions"}
                                        : null,
                                    comments: {
                                        nodes: [
                                            {
                                                author: {
                                                    login: "github-actions",
                                                },
                                                body: `**${defectLabel}:** ${DEFECT.subject} ${DEFECT.discussion} ${DEFECT.failure_scenario}`,
                                            },
                                            {
                                                author: {login: "Bcdirito"},
                                                body: "Fixed the expiration path.",
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        }),
        async () => {
            throw new Error("Unexpected ticket fetch");
        },
        {
            repo: "Khan/webapp",
            prNumber: 42048,
            repoRoot: "/work",
            env: canary ? {REVIEW_CANARY: "1"} : {},
        },
    );
    // Force a full re-review on both rounds, independently of cache scoping.
    fs.files[`${REVIEW}/rereview-plan.json`] = JSON.stringify({depth: "full"});
    fs.files[`${REVIEW}/routing.json`] = JSON.stringify({
        enabledReviewers: ["holistic"],
        lensesToSpawn: [],
        runBudget: {maxReviewerInvocations: 10, tier: "High"},
    });
};

const dispatch = async (
    fs: ReturnType<typeof fakeFs>,
    firstRound: boolean,
    defectLabel: string,
    answered = true,
    reconcilerFormat = "json",
) => {
    const outputs: Record<string, unknown> = {
        "pattern-triage": {patterns: [], reviewFiles: [PATH, "defect.ts"]},
        "correctness-reviewer": {
            findings: [{...DEFECT, label: defectLabel}],
            files: [],
        },
        holistic: {findings: [fixture.candidate]},
        "skill-auditor": {findings: []},
        "thread-reconciler": {
            resolve: [QUESTION.thread_id, FIXED],
            keep: [],
            ...(answered ? {answered: [QUESTION.thread_id]} : {}),
            skipLines: [],
        },
        "claim-clusterer": {clusters: []},
        "claim-validator": {
            claims: [
                {
                    id: "correctness-reviewer-1",
                    verification: "confirmed",
                    confidence: 0.9,
                },
                {id: "holistic-1", verification: "confirmed", confidence: 0.9},
            ],
        },
    };
    for (const name of Object.keys(outputs)) {
        fs.files[
            `/work/.claude/agents/${name}.md`
        ] = `---\nname: ${name}\nmodel: test\n---\nReturn JSON.`;
    }
    const calls: string[] = [];
    const runner: AgentRunner = async (request) => {
        calls.push(request.name);
        const json = JSON.stringify(outputs[request.name]);
        const output =
            request.name !== "thread-reconciler" || reconcilerFormat === "json"
                ? json
                : reconcilerFormat === "fenced"
                ? `Reconciliation result:\n\`\`\`json\n${json}\n\`\`\`\nDone.`
                : `Reconciliation result:\n${json}\nDone.`;
        return {
            output,
            usd: 0,
            turns: 1,
            wallMs: 1,
        };
    };
    const result = await runDispatch({fs, runner, repoRoot: "/work"});
    expect(result.depth).toBe("full");
    expect(calls.includes("thread-reconciler")).toBe(firstRound);
    return {result, plan: runSubmissionCli(fs, "/work")};
};

const saveCache = (
    fs: ReturnType<typeof fakeFs>,
    plan: ReturnType<typeof runSubmissionCli>,
    queueResolve = true,
) => {
    fs.files["/tmp/gh-aw/agent_output.json"] = JSON.stringify({
        items: [
            {type: "submit_pull_request_review", event: plan.event},
            ...(queueResolve
                ? plan.resolve.map((threadId) => ({
                      type: "resolve_pull_request_review_thread",
                      thread_id: threadId,
                  }))
                : []),
        ],
    });
    const saved = runCacheRecordCli(fs, "2026-09-08T15:47:28Z");
    expect(saved.written).toBe(true);
    return saved;
};

describe("answered scope question across full re-reviews", () => {
    it("reproduces the recorded v1.25.0 corpus gap without changing similarity floors", () => {
        const open = openThreadsFromStaged([QUESTION], new Set());
        const score = openThreadScore(fixture.candidate, open[0]);
        expect(score).toEqual({
            jaccard: 39 / 176,
            overlap: 13 / 30,
            sharedBigrams: 14,
        });
        const replay = suppressTrackedDuplicates(
            [fixture.candidate],
            [QUESTION],
            [],
            new Set(fixture.reconciliation.resolve),
        );
        expect(replay.kept).toEqual([fixture.candidate]);
        expect(replay.suppressed).toEqual([]);
        expect(
            suppressTrackedDuplicates(
                [fixture.candidate],
                [QUESTION],
                [],
                new Set(),
            ).kept,
        ).toEqual([]);
    });

    it.each([
        ["suggestion (non-blocking)", "json"],
        ["question (non-blocking)", "json"],
        ["issue (blocking)", "json"],
        ["suggestion (non-blocking)", "fenced"],
        ["suggestion (non-blocking)", "prose"],
    ])(
        "retains an explicit answer, while a fixed-then-regressed %s still posts (%s output)",
        async (label, reconcilerFormat) => {
            const fs = fakeFs();
            await stage(fs, false, label);
            expect(
                JSON.parse(fs.files[`${REVIEW}/threads.json`])[0].comments,
            ).toEqual(QUESTION.comments);
            const first = await dispatch(
                fs,
                true,
                label,
                true,
                reconcilerFormat,
            );
            if (reconcilerFormat !== "json") {
                expect(() =>
                    JSON.parse(
                        fs.files[`${REVIEW}/out/thread-reconciler.json`],
                    ),
                ).toThrow();
            }
            expect(first.result.claims.map((c) => c.id)).toEqual([
                "correctness-reviewer-1",
            ]);
            expect(first.result.threadSuppressions).toEqual([
                expect.objectContaining({
                    id: "holistic-1",
                    thread_id: QUESTION.thread_id,
                    adjudicated: true,
                    threadBlocking: false,
                }),
            ]);
            expect(first.plan.resolve).toEqual([QUESTION.thread_id, FIXED]);
            expect(first.plan.comments).toHaveLength(1);
            expect(first.plan.comments[0].path).toBe("defect.ts");
            expect(first.plan.event).toBe(
                label === "issue (blocking)" ? "REQUEST_CHANGES" : "APPROVE",
            );
            const saved = saveCache(fs, first.plan);
            expect(saved.record?.answeredQuestions).toEqual([
                expect.objectContaining({
                    thread_id: QUESTION.thread_id,
                    author: "Bcdirito",
                }),
            ]);

            // A fresh filesystem prevents stale out/ files from standing in
            // for memory. Both threads now report the same bot resolver.
            const next = fakeFs({[CACHE]: fs.files[CACHE]});
            await stage(next, true, label);
            expect(JSON.parse(next.files[`${REVIEW}/threads.json`])).toEqual(
                [],
            );
            expect(
                JSON.parse(next.files[`${REVIEW}/adjudicated-threads.json`]),
            ).toEqual([
                expect.objectContaining({
                    thread_id: QUESTION.thread_id,
                    resolvedBy: "github-actions",
                    answeredBy: "Bcdirito",
                }),
            ]);
            const second = await dispatch(next, false, label);
            expect(second.result.claims.map((c) => c.id)).toEqual([
                "correctness-reviewer-1",
            ]);
            expect(second.result.threadSuppressions).toEqual([
                expect.objectContaining({
                    id: "holistic-1",
                    thread_id: QUESTION.thread_id,
                    adjudicated: true,
                }),
            ]);
            expect(second.plan.comments).toHaveLength(1);
            expect(second.plan.comments[0].path).toBe("defect.ts");
            expect(second.plan.event).toBe(first.plan.event);
            expect(
                saveCache(next, second.plan).record?.answeredQuestions,
            ).toEqual(saved.record?.answeredQuestions);
        },
    );

    it("doesn't infer an answer from an old resolve list or an author reply", async () => {
        const fs = fakeFs();
        await stage(fs, false, DEFECT.label);
        const {result, plan} = await dispatch(fs, true, DEFECT.label, false);
        expect(result.claims.map((c) => c.id)).toContain("holistic-1");
        expect(saveCache(fs, plan).record?.answeredQuestions).toBeUndefined();
    });

    it("doesn't remember an answer unless its resolution was queued", async () => {
        const fs = fakeFs();
        await stage(fs, false, DEFECT.label);
        const {plan} = await dispatch(fs, true, DEFECT.label);
        expect(
            saveCache(fs, plan, false).record?.answeredQuestions,
        ).toBeUndefined();
    });

    it("keeps canary staging history-blind even with a cached answer", async () => {
        const fs = fakeFs();
        await stage(fs, false, DEFECT.label);
        saveCache(fs, (await dispatch(fs, true, DEFECT.label)).plan);
        const next = fakeFs({[CACHE]: fs.files[CACHE]});
        await stage(next, true, DEFECT.label, true);
        expect(
            JSON.parse(next.files[`${REVIEW}/adjudicated-threads.json`]),
        ).toEqual([]);
    });
});
