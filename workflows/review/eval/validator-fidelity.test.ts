import {afterEach, describe, expect, it} from "vitest";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

import {loadFidelityFixtures} from "./claim-fidelity";
import {outOfScopeRead} from "./read-scope";
import {hashFiles} from "./fidelity-provenance";
import {
    inputClaim,
    runValidatorFidelity,
    scoreValidatorOutput,
    VALIDATOR_IMPLEMENTATION_FILES,
    type SampleKind,
} from "./validator-fidelity";
import {
    prepareSnapshot,
    readSnapshot,
    sha256,
    stageValidatorCase,
} from "./validator-fidelity-stage";
import type {LiveAgentRequest, LiveAgentResult} from "./live-producer";

const fixtures = loadFidelityFixtures();
const roots: string[] = [];
const temp = () => {
    const root = mkdtempSync(join(tmpdir(), "validator-fidelity-test-"));
    roots.push(root);
    return root;
};
afterEach(() =>
    roots.splice(0).forEach((r) => rmSync(r, {recursive: true, force: true})),
);

const sample = () => {
    const root = temp();
    const original = fixtures[0];
    const path = original.corpusCase.changedFiles[0].path;
    const head = Buffer.from("package sample\nvar Answer = 2\n");
    const base = Buffer.from("package sample\nvar Answer = 1\n");
    const fixture = {
        ...original,
        corpusCase: {...original.corpusCase, id: "fixture"},
        provenance: {
            ...original.provenance,
            reviewedCommit: "a".repeat(40),
            evidence: [
                {
                    ...original.provenance.evidence[0],
                    path,
                    commit: "a".repeat(40),
                    fileSha256: sha256(head),
                },
                {
                    ...original.provenance.evidence[0],
                    path,
                    commit: "b".repeat(40),
                    fileSha256: sha256(base),
                },
            ],
        },
    };
    const sourceRoot = join(root, "sources");
    const snapshot = prepareSnapshot(fixture, sourceRoot, (_path, commit) =>
        commit === "a".repeat(40) ? head : base,
    );
    return {root, fixture, snapshot, sourceRoot, head, base};
};
const REVIEW_MD = [
    "## agent: `claim-validator`",
    "---",
    "name: claim-validator",
    "description: validator",
    "model: test-model",
    "---",
    "Read /tmp/gh-aw/review/claims.json and /tmp/gh-aw/review/pr.diff.",
].join("\n");
const result = (
    output = JSON.stringify({
        claims: [{id: "candidate-1", verification: "confirmed"}],
    }),
): LiveAgentResult => ({
    output,
    usd: 0.1,
    turns: 2,
    toolCalls: 2,
    deniedReads: 0,
    wallMs: 20,
});

const replay = async (
    runner: (request: LiveAgentRequest) => Promise<LiveAgentResult>,
    repeats = 1,
    maxUsd = 8,
) => {
    const s = sample();
    const checkpoints: string[] = [];
    const report = await runValidatorFidelity(
        [s.fixture],
        [s.snapshot],
        REVIEW_MD,
        {
            sourceRoot: s.sourceRoot,
            stageRoot: join(s.root, "cases"),
            runner,
            repeats,
            maxUsd,
            checkpoint: (r) => checkpoints.push(JSON.stringify(r)),
        },
    );
    return {...s, report, checkpoints};
};

describe("validator fidelity replay", () => {
    it("blinds case ids and clean-control labels without changing comment text", () => {
        for (const fixture of fixtures) {
            const original = inputClaim(fixture, "original");
            const clean = inputClaim(fixture, "clean-control");
            expect(original.id).toBe("candidate-1");
            expect(clean.id).toBe("candidate-1");
            expect(original.discussion).toBe(
                fixture.corpusCase.findings[0].finding.model_authored_prose,
            );
            expect(clean.subject).toBe(
                fixture.control.claims[0].corrected.subject,
            );
        }
    });

    it("scores original comments separately from clean controls", () => {
        for (const fixture of fixtures) {
            for (const kind of ["original", "clean-control"] as const) {
                const score = scoreValidatorOutput(
                    fixture,
                    inputClaim(fixture, kind),
                    result().output,
                );
                expect(score.retained).toBe(true);
                expect(score.unexpectedBlocking).toBe(false);
                expect(score.facets).toEqual(
                    kind === "original"
                        ? fixture.originalPass
                        : {
                              mainDefect: true,
                              proposedFix: true,
                              supportingAssertions: true,
                              visibleConsequence: true,
                          },
                );
            }
        }
    });

    it.each([
        {claims: []},
        {claims: [{id: "unknown", verification: "confirmed"}]},
        {claims: [{id: "candidate-1", verification: "unknown"}]},
        {
            claims: [
                {id: "candidate-1", verification: "confirmed"},
                {id: "candidate-1", verification: "refuted"},
            ],
        },
    ])(
        "does not count an invalid or missing verification as retention: %j",
        (output) => {
            expect(() =>
                scoreValidatorOutput(
                    fixtures[0],
                    inputClaim(fixtures[0], "original"),
                    JSON.stringify(output),
                ),
            ).toThrow();
        },
    );

    it("replays all recorded live outputs without changing their lexical scores or rendered comments", () => {
        const baseline = JSON.parse(
            readFileSync(
                "workflows/review/eval/validator-fidelity-baseline.json",
                "utf8",
            ),
        ) as {
            samples: {
                caseId: string;
                kind: SampleKind;
                inputSha256: string;
                result: {output: string};
                score: ReturnType<typeof scoreValidatorOutput>;
            }[];
        };
        expect(baseline.samples).toHaveLength(18);
        for (const recorded of baseline.samples) {
            const fixture = fixtures.find(
                (f) => f.corpusCase.id === recorded.caseId,
            );
            expect(fixture).toBeDefined();
            if (fixture === undefined) {
                throw new Error(`Missing fixture: ${recorded.caseId}`);
            }
            const claim = inputClaim(fixture, recorded.kind);
            expect(sha256(JSON.stringify(claim))).toBe(recorded.inputSha256);
            expect(
                scoreValidatorOutput(fixture, claim, recorded.result.output),
            ).toEqual(recorded.score);
        }
    });

    it("uses production's tolerant JSON extraction", () => {
        expect(
            scoreValidatorOutput(
                fixtures[0],
                inputClaim(fixtures[0], "original"),
                `\`\`\`json\n${result().output}\n\`\`\``,
            ).retained,
        ).toBe(true);
    });

    it("records dropped useful findings and unexpected severity increases", () => {
        const fixture = fixtures[0];
        const claim = inputClaim(fixture, "original");
        const dropped = scoreValidatorOutput(
            fixture,
            claim,
            JSON.stringify({claims: [{id: claim.id, verification: "refuted"}]}),
        );
        expect(dropped.retained).toBe(false);
        expect(Object.values(dropped.facets)).toEqual([
            false,
            false,
            false,
            false,
        ]);
        const raised = scoreValidatorOutput(
            fixture,
            claim,
            JSON.stringify({
                claims: [
                    {
                        id: claim.id,
                        verification: "confirmed",
                        corrected: {label: "issue (blocking)"},
                    },
                ],
            }),
        );
        expect(raised.unexpectedBlocking).toBe(true);
    });

    it("rejects source bytes that do not match the commit-pinned evidence", () => {
        const {fixture, root} = sample();
        expect(() =>
            prepareSnapshot(fixture, join(root, "bad"), () =>
                Buffer.from("wrong revision"),
            ),
        ).toThrow("hash mismatch");
    });

    it("rechecks cached source and rejects path traversal", () => {
        const {snapshot, sourceRoot} = sample();
        writeFileSync(
            join(sourceRoot, snapshot.caseId, "head", snapshot.files[0].path),
            "wrong revision",
        );
        expect(() => readSnapshot(sourceRoot, snapshot)).toThrow(
            "Cached source hash mismatch",
        );
        expect(() =>
            readSnapshot(sourceRoot, {
                ...snapshot,
                files: [{...snapshot.files[0], path: "../../outside"}],
            }),
        ).toThrow("Invalid snapshot path");
    });

    it("stages real base/head differences and denies access to answers and other samples", () => {
        const {snapshot, sourceRoot, fixture, root, head} = sample();
        const staged = stageValidatorCase(
            sourceRoot,
            snapshot,
            inputClaim(fixture, "original"),
            join(root, "sample"),
        );
        expect(
            readFileSync(join(staged.checkoutDir, snapshot.files[0].path)),
        ).toEqual(head);
        const diff = readFileSync(join(staged.contextDir, "pr.diff"), "utf8");
        expect(diff).toContain("-var Answer = 1");
        expect(diff).toContain("+var Answer = 2");
        expect(readdirSync(staged.contextDir).sort()).toEqual([
            "base-input",
            "claims.json",
            "pr-context.json",
            "pr.diff",
        ]);
        for (const outside of [
            resolve(fixture.corpusCase.sourcePath),
            join(root, "sample-2/context/claims.json"),
            sourceRoot,
        ]) {
            expect(
                outOfScopeRead(
                    "Read",
                    {file_path: outside},
                    staged.rootDir,
                    staged.checkoutDir,
                ),
            ).toBeDefined();
        }
        const input = readFileSync(
            join(staged.contextDir, "claims.json"),
            "utf8",
        );
        expect(input).not.toContain("originalPass");
        expect(input).not.toContain("clean-control");
        expect(input).not.toContain("fileSha256");
    });

    it("stages an added file against an empty base through preparation and cache verification", () => {
        const {fixture, sourceRoot, root, head, base} = sample();
        const path = "added.go";
        const addedHead = Buffer.from("package sample\nvar Added = true\n");
        const withAddition = {
            ...fixture,
            provenance: {
                ...fixture.provenance,
                evidence: [
                    ...fixture.provenance.evidence,
                    {
                        ...fixture.provenance.evidence[0],
                        path,
                        fileSha256: sha256(addedHead),
                    },
                ],
            },
        };
        const snapshot = prepareSnapshot(
            withAddition,
            sourceRoot,
            (file, commit) => {
                if (file === path) {
                    return commit === fixture.provenance.reviewedCommit
                        ? addedHead
                        : null;
                }
                return commit === fixture.provenance.reviewedCommit
                    ? head
                    : base;
            },
        );
        expect(snapshot.files.find((f) => f.path === path)).toEqual({
            path,
            headHash: sha256(addedHead),
            baseHash: null,
        });
        expect(
            readSnapshot(sourceRoot, snapshot).find((f) => f.path === path)
                ?.base,
        ).toEqual(Buffer.alloc(0));
        const staged = stageValidatorCase(
            sourceRoot,
            snapshot,
            inputClaim(withAddition, "original"),
            join(root, "addition"),
        );
        expect(readFileSync(join(staged.checkoutDir, path))).toEqual(addedHead);
        const diff = readFileSync(join(staged.contextDir, "pr.diff"), "utf8");
        expect(diff).toContain(
            `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,2 @@\n+package sample\n+var Added = true`,
        );
        expect(diff).toContain("-var Answer = 1");
        expect(diff).toContain("+var Answer = 2");
    });

    it("records an implementation manifest independently of the lexical scorer hash", async () => {
        const {report, checkpoints} = await replay(async () => result());
        expect(report.implementationFiles).toEqual(
            VALIDATOR_IMPLEMENTATION_FILES,
        );
        expect(report.implementationFiles).toEqual(
            expect.arrayContaining([
                "workflows/review/eval/validator-fidelity.ts",
                "workflows/review/eval/validator-fidelity-stage.ts",
                "workflows/review/eval/validator-fidelity-live.ts",
                "workflows/review/eval/live-runner.ts",
                "workflows/review/eval/read-scope.ts",
                "workflows/review/lib/dispatch-contracts.ts",
                "workflows/review/lib/submission-render.ts",
                "workflows/review/lib/render-comment.ts",
                "pnpm-lock.yaml",
            ]),
        );
        expect(report.implementationSha256).toBe(
            hashFiles(report.implementationFiles),
        );
        expect(JSON.parse(checkpoints[0]).implementationSha256).toBe(
            report.implementationSha256,
        );
        expect(report.scorerSha256).toBe(
            sha256(readFileSync("workflows/review/eval/claim-fidelity.ts")),
        );
        for (const changed of report.implementationFiles) {
            const modified = hashFiles(report.implementationFiles, (path) =>
                path === changed
                    ? Buffer.concat([readFileSync(path), Buffer.from("\n")])
                    : readFileSync(path),
            );
            expect(modified, changed).not.toBe(report.implementationSha256);
        }
    });

    it("repeats identical inputs, alternates ordering, and checkpoints every sample", async () => {
        const requests: LiveAgentRequest[] = [];
        const {report, checkpoints} = await replay(async (r) => {
            requests.push(r);
            return result();
        }, 2);
        expect(requests).toHaveLength(4);
        expect(report.samples.map((s) => s.kind)).toEqual([
            "original",
            "clean-control",
            "clean-control",
            "original",
        ]);
        expect(report.samples[0].inputSha256).toBe(
            report.samples[3].inputSha256,
        );
        expect(report.samples[1].inputSha256).toBe(
            report.samples[2].inputSha256,
        );
        expect(checkpoints).toHaveLength(5);
        expect(new Set(requests.map((r) => r.readRoot)).size).toBe(4);
        for (const request of requests) {
            expect(request.model).toBe("test-model");
            expect(request.maxTurns).toBe(12);
            expect(request.timeoutMs).toBe(180_000);
            expect(request.prompt).toContain(
                join(request.readRoot, "context/claims.json"),
            );
            expect(request.prompt).not.toContain("originalPass");
        }
    });

    it("keeps errors separate from scored findings and counts their known spend", async () => {
        const {report} = await replay(async () => result("not JSON"));
        expect(
            report.samples.every(
                (s) => s.status === "error" && s.score === undefined,
            ),
        ).toBe(true);
        expect(report.spentUsd).toBeCloseTo(0.2);
        expect(report.spendComplete).toBe(true);
    });

    it("stops after an unpriced failure rather than spending past an unknown total", async () => {
        const {report} = await replay(async () => {
            throw new Error("transport failed");
        });
        expect(report.samples.map((s) => s.status)).toEqual([
            "error",
            "skipped",
        ]);
        expect(report.spendComplete).toBe(false);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "stops after an unusable cost without losing known spend: %s",
        async (usd) => {
            let calls = 0;
            const {report, checkpoints} = await replay(async () => {
                calls++;
                return calls === 1 ? result() : {...result(), usd};
            }, 2);
            expect(calls).toBe(2);
            expect(report.samples.map((s) => s.status)).toEqual([
                "scored",
                "error",
                "skipped",
                "skipped",
            ]);
            expect(report.samples[1].error).toContain(
                "Runner returned no usable cost",
            );
            expect(report.samples[1].score).toBeUndefined();
            expect(report.spentUsd).toBeCloseTo(0.1);
            expect(report.spendComplete).toBe(false);
            expect(JSON.parse(checkpoints[2]).spendComplete).toBe(false);
            expect(JSON.parse(checkpoints.at(-1)!).spentUsd).toBeCloseTo(0.1);
        },
    );

    it("stops dispatching at the spend threshold without calling skips failures", async () => {
        const {report} = await replay(async () => result(), 1, 0.1);
        expect(report.samples.map((s) => s.status)).toEqual([
            "scored",
            "skipped",
        ]);
        expect(report.spentUsd).toBeCloseTo(0.1);
    });
});
