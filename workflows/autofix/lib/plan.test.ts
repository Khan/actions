import {describe, expect, it} from "vitest";

import {buildPlan, runPlanCli} from "./plan.ts";
import type {PlanCliFs, PlanInput} from "./plan.ts";
import {parseTrailer} from "./trailer.ts";
import {
    computeHunkSignature,
    renderRereviewStamp,
    STAMP_SCHEMA_VERSION,
} from "../../review/lib/rereview-mode.ts";
import type {StagedThread} from "../../review/lib/rereview.ts";

const DIFF =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n" +
    "@@ -1,1 +1,2 @@\n context\n+added line\n";

const OTHER_DIFF =
    "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n" +
    "@@ -1,1 +1,2 @@\n context\n+other line\n";

const reviewStamped = (diff: string) => ({
    body: renderRereviewStamp({
        schemaVersion: STAMP_SCHEMA_VERSION,
        depth: "full" as const,
        verdict: "REQUEST_CHANGES",
        anchorDraft: false,
        anchorHunks: computeHunkSignature(diff),
    }),
    submittedAt: "2026-07-01T00:00:00Z",
});

const thread = (
    over: Partial<StagedThread> & {body: string},
): StagedThread => ({
    thread_id: over.thread_id ?? "T1",
    path: over.path ?? "src/a.ts",
    line: over.line === undefined ? 2 : over.line,
    comments: [{author: "github-actions[bot]", body: over.body}],
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    labels: ["autofix: blocking"],
    threads: [thread({body: "**issue (blocking):** guard is inverted"})],
    priorReviews: [reviewStamped(DIFF)],
    diffText: DIFF,
    commitMessages: [],
    isFork: false,
    ...over,
});

describe("buildPlan", () => {
    it("arms with the in-scope work and a rendered trailer", () => {
        const plan = buildPlan(input());
        expect(plan.status).toBe("armed");
        expect(plan.scopes).toEqual(["blocking"]);
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1"]);
        expect(plan.labelsToRemove).toEqual(["autofix: blocking"]);
        expect(parseTrailer(`x\n\n${plan.trailer}`)).toMatchObject({
            scopes: ["blocking"],
            cycle: 1,
            threadIds: ["T1"],
        });
    });

    it("refuses an unimplemented axis and still clears the labels", () => {
        const plan = buildPlan(input({labels: ["autofix: loop"]}));
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("cadence");
        // A label left on after a refusal reads as "still queued".
        expect(plan.labelsToRemove).toEqual(["autofix: loop"]);
        expect(plan.trailer).toBe("");
    });

    it("refuses only when the PR has never been reviewed", () => {
        const plan = buildPlan(input({priorReviews: []}));
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("nothing to autofix");
        expect(plan.items).toEqual([]);
    });

    it("still arms against an unstamped review, with a degraded note", () => {
        // The Khan/webapp#41130 shape: real blocking feedback, no fingerprint.
        const plan = buildPlan(
            input({
                priorReviews: [
                    {
                        body: "Changes requested — see inline comments.",
                        submittedAt: "2026-07-01T00:00:00Z",
                    },
                ],
            }),
        );
        expect(plan.status).toBe("armed");
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1"]);
        expect(plan.degradedNote).toContain("thread anchors only");
        expect(plan.stalePaths).toEqual([]);
    });

    it("still arms when the fingerprint overflowed", () => {
        const plan = buildPlan(
            input({
                priorReviews: [
                    {
                        body: renderRereviewStamp({
                            schemaVersion: STAMP_SCHEMA_VERSION,
                            depth: "full",
                            verdict: "REQUEST_CHANGES",
                            anchorDraft: false,
                            anchorHunks: "overflow",
                        }),
                        submittedAt: "2026-07-01T00:00:00Z",
                    },
                ],
            }),
        );
        expect(plan.status).toBe("armed");
        expect(plan.degradedNote).toContain("overflowed");
    });

    it("leaves the degraded note empty when the fingerprint check ran", () => {
        expect(buildPlan(input()).degradedNote).toBe("");
    });

    it("still drops an outdated thread when running degraded", () => {
        // The anchor check is what the degraded path leans on, so it has to
        // keep working when the fingerprint is gone.
        const plan = buildPlan(
            input({
                priorReviews: [
                    {
                        body: "Changes requested — see inline comments.",
                        submittedAt: "2026-07-01T00:00:00Z",
                    },
                ],
                threads: [
                    thread({body: "**issue (blocking):** x", line: null}),
                ],
            }),
        );
        expect(plan.status).toBe("no-op");
        expect(plan.skipped[0].reason).toBe("outdated-anchor");
    });

    it("drops a finding whose file changed after the review", () => {
        // The review saw src/a.ts; the head now also carries an edit to it.
        const movedOn =
            DIFF +
            "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n" +
            "@@ -9,1 +9,2 @@\n context\n+later edit\n";
        const plan = buildPlan(input({diffText: movedOn}));
        expect(plan.status).toBe("no-op");
        expect(plan.stalePaths).toEqual(["src/a.ts"]);
        expect(plan.skipped[0]).toMatchObject({
            threadId: "T1",
            reason: "stale-path",
        });
    });

    it("fixes findings in untouched files when another file went stale", () => {
        // The degradation the per-path guard buys: partial work, not refusal.
        const reviewed = DIFF + OTHER_DIFF;
        const head =
            DIFF +
            "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n" +
            "@@ -1,1 +1,2 @@\n context\n+other line CHANGED\n";
        const plan = buildPlan(
            input({
                priorReviews: [reviewStamped(reviewed)],
                diffText: head,
                threads: [
                    thread({thread_id: "T1", body: "**issue (blocking):** a"}),
                    thread({
                        thread_id: "T2",
                        path: "src/b.ts",
                        body: "**issue (blocking):** b",
                    }),
                ],
            }),
        );
        expect(plan.status).toBe("armed");
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1"]);
        expect(plan.skipped).toEqual([
            {
                threadId: "T2",
                path: "src/b.ts",
                reason: "stale-path",
                label: "issue (blocking)",
            },
        ]);
    });

    it("is a no-op, not a refusal, when nothing is in scope", () => {
        const plan = buildPlan(
            input({
                threads: [
                    thread({body: "**nitpick (non-blocking):** rename this"}),
                ],
            }),
        );
        expect(plan.status).toBe("no-op");
        expect(plan.reason).toContain("no open blocking findings");
        expect(plan.labelsToRemove).toEqual(["autofix: blocking"]);
    });

    it("unions both scopes when both labels are on", () => {
        const plan = buildPlan(
            input({
                labels: ["autofix: blocking", "autofix: nits"],
                threads: [
                    thread({thread_id: "T1", body: "**issue (blocking):** a"}),
                    thread({
                        thread_id: "T2",
                        body: "**nitpick (non-blocking):** b",
                    }),
                ],
            }),
        );
        expect(plan.status).toBe("armed");
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1", "T2"]);
        expect(plan.labelsToRemove.sort()).toEqual([
            "autofix: blocking",
            "autofix: nits",
        ]);
    });

    it("takes its cycle number from the branch ledger", () => {
        const prior =
            "autofix: address reviewer feedback\n\n" +
            "Autofix-Version: 1\nAutofix-Scope: blocking\n" +
            "Autofix-Cycle: 1\nAutofix-Threads: T9\n";
        const plan = buildPlan(input({commitMessages: ["feat: x", prior]}));
        expect(plan.cycle).toBe(2);
        expect(parseTrailer(`x\n\n${plan.trailer}`)?.cycle).toBe(2);
    });

    it("reports no-op when the label is absent entirely", () => {
        const plan = buildPlan(input({labels: ["bug"]}));
        expect(plan.status).toBe("no-op");
        expect(plan.labelsToRemove).toEqual([]);
    });
});

describe("runPlanCli", () => {
    const fsFor = (files: Record<string, string>) => {
        const written: Record<string, string> = {};
        const fs: PlanCliFs = {
            existsSync: (path) => files[path] !== undefined,
            readFileSync: (path) => files[path],
            writeFileSync: (path, data) => {
                written[path] = data;
            },
        };
        return {fs, written};
    };

    it("reads the staged inputs and writes plan.json", () => {
        const {fs, written} = fsFor({
            "/tmp/gh-aw/autofix/labels.json": JSON.stringify([
                "autofix: blocking",
            ]),
            "/tmp/gh-aw/autofix/threads.json": JSON.stringify([
                thread({body: "**issue (blocking):** x"}),
            ]),
            "/tmp/gh-aw/autofix/prior-reviews.json": JSON.stringify([
                reviewStamped(DIFF),
            ]),
            "/tmp/gh-aw/autofix/pr.diff": DIFF,
            "/tmp/gh-aw/autofix/commits.json": JSON.stringify([]),
            "/tmp/gh-aw/autofix/context.json": JSON.stringify({isFork: false}),
        });
        const plan = runPlanCli(fs);
        expect(plan.status).toBe("armed");
        const onDisk = JSON.parse(written["/tmp/gh-aw/autofix/plan.json"]);
        expect(onDisk.items).toHaveLength(1);
        expect(written["/tmp/gh-aw/autofix/plan.json"].endsWith("\n")).toBe(
            true,
        );
    });

    it("degrades a missing input into an ordinary refusal, not a crash", () => {
        const {fs} = fsFor({
            "/tmp/gh-aw/autofix/labels.json": JSON.stringify([
                "autofix: blocking",
            ]),
        });
        expect(runPlanCli(fs).status).toBe("refused");
    });

    it("degrades malformed JSON the same way", () => {
        const {fs} = fsFor({
            "/tmp/gh-aw/autofix/labels.json": "{not json",
            "/tmp/gh-aw/autofix/pr.diff": DIFF,
        });
        expect(runPlanCli(fs).status).toBe("no-op");
    });
});

describe("buildPlan across both surfaces", () => {
    it("arms from an /autofix command with no label present", () => {
        const plan = buildPlan(
            input({labels: [], command: "/autofix blocking"}),
        );
        expect(plan.status).toBe("armed");
        expect(plan.surface).toBe("command");
        expect(plan.scopes).toEqual(["blocking"]);
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1"]);
    });

    it("never removes labels on a command-armed run", () => {
        // A stale label the author never acted on must survive an /autofix.
        const plan = buildPlan(
            input({
                labels: ["autofix: nits"],
                command: "/autofix blocking",
            }),
        );
        expect(plan.status).toBe("armed");
        expect(plan.labelsToRemove).toEqual([]);
    });

    it("never removes labels on a command-armed refusal either", () => {
        const plan = buildPlan(
            input({labels: ["autofix: nits"], command: "/autofix loop"}),
        );
        expect(plan.status).toBe("refused");
        expect(plan.surface).toBe("command");
        expect(plan.labelsToRemove).toEqual([]);
    });

    it("lets the command decide, never unioning it with stale labels", () => {
        // `autofix: nits` on the PR must not widen an explicit /autofix
        // blocking into both scopes.
        const plan = buildPlan(
            input({
                labels: ["autofix: nits"],
                command: "/autofix blocking",
                threads: [
                    thread({thread_id: "T1", body: "**issue (blocking):** a"}),
                    thread({
                        thread_id: "T2",
                        body: "**nitpick (non-blocking):** b",
                    }),
                ],
            }),
        );
        expect(plan.scopes).toEqual(["blocking"]);
        expect(plan.items.map((i) => i.threadId)).toEqual(["T1"]);
    });

    it("falls back to labels when the comment is not an autofix command", () => {
        const plan = buildPlan(
            input({labels: ["autofix: blocking"], command: "/review"}),
        );
        expect(plan.status).toBe("armed");
        expect(plan.surface).toBe("label");
        expect(plan.labelsToRemove).toEqual(["autofix: blocking"]);
    });

    it("falls back to labels for an empty or whitespace command", () => {
        for (const command of ["", "   "]) {
            const plan = buildPlan(
                input({labels: ["autofix: blocking"], command}),
            );
            expect(plan.surface).toBe("label");
        }
    });

    it("still removes every autofix label on a label-armed refusal", () => {
        const plan = buildPlan(
            input({labels: ["autofix: blocking", "autofix: loop"]}),
        );
        expect(plan.status).toBe("refused");
        expect(plan.labelsToRemove.sort()).toEqual([
            "autofix: blocking",
            "autofix: loop",
        ]);
    });

    it("produces an identical plan from equivalent label and command armings", () => {
        const viaLabel = buildPlan(input({labels: ["autofix: blocking"]}));
        const viaCommand = buildPlan(
            input({labels: [], command: "/autofix blocking"}),
        );
        expect(viaCommand.items).toEqual(viaLabel.items);
        expect(viaCommand.scopes).toEqual(viaLabel.scopes);
        expect(viaCommand.trailer).toEqual(viaLabel.trailer);
        expect(viaCommand.status).toEqual(viaLabel.status);
    });
});

describe("runPlanCli command staging", () => {
    it("reads command.txt when the comment path staged it", () => {
        const files: Record<string, string> = {
            "/tmp/gh-aw/autofix/labels.json": JSON.stringify([]),
            "/tmp/gh-aw/autofix/threads.json": JSON.stringify([
                thread({body: "**issue (blocking):** x"}),
            ]),
            "/tmp/gh-aw/autofix/prior-reviews.json": JSON.stringify([
                reviewStamped(DIFF),
            ]),
            "/tmp/gh-aw/autofix/pr.diff": DIFF,
            "/tmp/gh-aw/autofix/commits.json": JSON.stringify([]),
            "/tmp/gh-aw/autofix/context.json": JSON.stringify({isFork: false}),
            "/tmp/gh-aw/autofix/command.txt": "/autofix blocking\r\n",
        };
        const plan = runPlanCli({
            existsSync: (path) => files[path] !== undefined,
            readFileSync: (path) => files[path],
            writeFileSync: () => {},
        });
        expect(plan.status).toBe("armed");
        expect(plan.surface).toBe("command");
    });

    it("falls back to labels when command.txt is absent", () => {
        const files: Record<string, string> = {
            "/tmp/gh-aw/autofix/labels.json": JSON.stringify([
                "autofix: blocking",
            ]),
            "/tmp/gh-aw/autofix/threads.json": JSON.stringify([
                thread({body: "**issue (blocking):** x"}),
            ]),
            "/tmp/gh-aw/autofix/prior-reviews.json": JSON.stringify([
                reviewStamped(DIFF),
            ]),
            "/tmp/gh-aw/autofix/pr.diff": DIFF,
            "/tmp/gh-aw/autofix/commits.json": JSON.stringify([]),
            "/tmp/gh-aw/autofix/context.json": JSON.stringify({isFork: false}),
        };
        const plan = runPlanCli({
            existsSync: (path) => files[path] !== undefined,
            readFileSync: (path) => files[path],
            writeFileSync: () => {},
        });
        expect(plan.status).toBe("armed");
        expect(plan.surface).toBe("label");
    });
});

describe("guards the command path cannot express in the workflow if:", () => {
    // Khan/actions#298 review, blocking: the issue_comment branch of the gate
    // carries neither check, and both the workflow comment and the README said
    // they "move into the plan" while the plan did not implement them.
    it("refuses a fork", () => {
        const plan = buildPlan(input({isFork: true}));
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("fork");
    });

    it("refuses when the fork status is unknown", () => {
        // Fail closed: an unreadable context must not authorise a push.
        const plan = buildPlan(input({isFork: undefined}));
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("could not be");
    });

    it("refuses a PR carrying skip-ai-review", () => {
        const plan = buildPlan(
            input({
                isFork: false,
                labels: ["autofix: blocking", "skip-ai-review"],
            }),
        );
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("skip-ai-review");
    });

    it("proceeds on a same-repo PR without the label", () => {
        expect(buildPlan(input({isFork: false})).status).toBe("armed");
    });

    it("enforces them on the command path too", () => {
        const plan = buildPlan(
            input({labels: [], command: "/autofix blocking", isFork: true}),
        );
        expect(plan.status).toBe("refused");
        expect(plan.reason).toContain("fork");
    });
});
