import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

import {
    parseCase,
    type CorpusCase,
    type RecordedFinding,
} from "./corpus/loader";
import {matchCase} from "./live-match";
import {runCase} from "./runner";
import {accountLiveRun} from "./live-accounting";
import {scoreRereview} from "./rereview-match";
import {compareUsefulCoverage, valueSummary} from "./live-value";
import {runArm} from "./live-ab";

const evidence = JSON.parse(
    readFileSync(`${__dirname}/field-parity-evidence.json`, "utf8"),
) as {
    sameRunDuplicateControls: {
        key: string;
        comments: {id: number; path: string; line: number}[];
    }[];
    overlapControls: {key: string; source: string; path: string}[];
};
const finding = (
    id: string,
    path: string,
    line: number,
    mechanism: string,
    source = "scripted-a",
): RecordedFinding => ({
    source,
    finding: {
        schema_version: 2,
        id,
        lens: "correctness",
        anchor: {type: "line", path, line, side: "RIGHT"},
        severity: "advisory",
        confidence: 0.8,
        producing_hunt: "scripted",
        evidence_trace: [path],
        failure_scenario: mechanism,
        model_authored_prose: mechanism,
    },
});
const corpus = (
    key: string,
    locations: {path: string; line: number}[],
    findings: RecordedFinding[],
): CorpusCase => {
    const paths = [...new Set(locations.map((l) => l.path))];
    const diff = paths
        .map((path) => {
            const lines = Math.max(
                ...locations.filter((l) => l.path === path).map((l) => l.line),
            );
            return (
                `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n` +
                Array.from({length: lines}, () => "+fixture").join("\n") +
                "\n"
            );
        })
        .join("");
    return parseCase(
        {
            id: key,
            category: "golden",
            description:
                "Scripted accounting control using audited locations, not a source fixture or live result.",
            tags: ["live"],
            changedFiles: paths.map((path) => ({path, status: "added"})),
            diff,
            findings,
            expected: {verdict: "APPROVE"},
            routerConfig: {nonBlockingInlineBudget: 1},
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
                mustCatchSpecs: [
                    {
                        key,
                        path: locations[0]!.path,
                        lineStart: locations[0]!.line,
                        lineEnd: locations[0]!.line,
                        mechanism: [key],
                        ...(locations.length > 1
                            ? {
                                  altLocations: locations.slice(1).map((l) => ({
                                      path: l.path,
                                      lineStart: l.line,
                                      lineEnd: l.line,
                                  })),
                              }
                            : {}),
                    },
                ],
            },
        },
        `test://${key}`,
    );
};

describe("September 3-8 webapp accounting controls", () => {
    for (const control of evidence.sameRunDuplicateControls) {
        it(`counts ${control.key} once across inline and collapsed copies`, async () => {
            const records = control.comments.map((c, i) =>
                finding(
                    String(c.id),
                    c.path,
                    c.line,
                    control.key,
                    `scripted-${i}`,
                ),
            );
            const c = corpus(control.key, control.comments, records);
            const result = runCase(c, {
                posting: {depth: "full", nonBlockingInlineBudget: 1},
            });
            const match = await matchCase(c, result);
            expect(match.caught).toHaveLength(1);
            expect(match.duplicates).toHaveLength(1);
            expect(match.unmatchedFindingIds).toEqual([]);
            expect(result.plannedReview.comments).toHaveLength(1);
            expect(result.posting?.collapsedIds).toHaveLength(1);
            expect(result.plannedReview.body).toContain(
                "Collapsed observations (1)",
            );
            const accounting = accountLiveRun(
                {findings: records, validation: [], perAgent: []},
                result,
                match,
            );
            expect(accounting.usefulDefects).toHaveLength(1);
            expect(accounting.usefulDefects[0]).toMatchObject({
                postedSources: ["scripted-0", "scripted-1"],
                inline: true,
                collapsed: true,
            });
        });
    }
    for (const control of evidence.overlapControls) {
        it(`doesn't credit a new source for the existing ${control.key} catch`, async () => {
            const before = finding(
                "prior",
                control.path,
                1,
                control.key,
                control.source,
            );
            const after = finding(
                "new",
                control.path,
                1,
                control.key,
                "scripted-new-reviewer",
            );
            const c = corpus(control.key, [{path: control.path, line: 1}], []);
            const base = await runArm(
                "baseline",
                [c],
                async () => ({
                    findings: [before],
                    validation: [],
                    perAgent: [],
                }),
                {maxUsd: 1, log: () => {}},
            );
            const cand = await runArm(
                "candidate",
                [c],
                async () => ({findings: [after], validation: [], perAgent: []}),
                {maxUsd: 1, log: () => {}},
            );
            expect(compareUsefulCoverage(base, cand)).toMatchObject({
                gained: 0,
                lost: 0,
                net: 0,
                usdPerNetUsefulCatch: null,
            });
            expect(compareUsefulCoverage(base, cand).paired[0]?.shared).toEqual(
                [control.key],
            );
        });
    }
    it("tracks the seed-target defect across its audited occurrences", () => {
        const mechanism = "missing seed integration target";
        const rereview = {
            priorDiff: "",
            priorVerdict: "APPROVE" as const,
            priorDepth: "full" as const,
            priorThreads: [
                {
                    key: "seed",
                    path: "testing/integrationtest/helpers.go",
                    line: 4,
                    relatedPaths: [
                        "services/users/integration/profile_integration_test.go",
                    ],
                    body: mechanism,
                    expect: "keep" as const,
                    mechanism: [mechanism],
                },
            ],
        };
        const repeated = finding(
            "again",
            "services/users/integration/profile_integration_test.go",
            32,
            mechanism,
        ).finding;
        const unrelated = finding(
            "different",
            "services/users/integration/profile_integration_test.go",
            32,
            "missing lint target",
        ).finding;
        const wrongFile = finding(
            "wrong-file",
            "unrelated/Makefile",
            100,
            mechanism,
        ).finding;
        const score = scoreRereview(rereview, {resolve: [], keep: ["t-seed"]}, [
            repeated,
            unrelated,
            wrongFile,
        ]);
        expect(score.duplicateFindingIds).toEqual(["again"]);
    });
});

describe("posting and matcher boundaries", () => {
    it("keeps an inline budget loss separate from losing the useful catch", async () => {
        const location = {path: "src/a.ts", line: 1};
        const c = corpus("useful", [location], []);
        const useful = finding("useful", location.path, 1, "useful");
        const noise = finding("noise", location.path, 1, "unrelated mechanism");
        const base = await runArm(
            "baseline",
            [c],
            async () => ({findings: [useful], validation: [], perAgent: []}),
            {maxUsd: 1, log: () => {}},
        );
        const cand = await runArm(
            "candidate",
            [c],
            async () => ({
                findings: [noise, useful],
                validation: [],
                perAgent: [],
            }),
            {maxUsd: 1, log: () => {}},
        );
        expect(compareUsefulCoverage(base, cand).paired[0]).toMatchObject({
            gained: [],
            lost: [],
            inlineDisplaced: ["useful"],
        });
        expect(cand.metrics.noise.numerator).toBe(1);
        expect(cand.perCase[0]?.accounting?.usefulDefects[0]?.collapsed).toBe(
            true,
        );
    });
    it("rejects matching only the anchor or an evidence-trace quotation", async () => {
        const record = finding(
            "negative",
            "src/a.ts",
            1,
            "a different mechanism",
        );
        record.finding.evidence_trace = ["seeded-mechanism"];
        const c = corpus(
            "seeded-mechanism",
            [{path: "src/a.ts", line: 1}],
            [record],
        );
        const match = await matchCase(c, runCase(c));
        expect(match.caught).toEqual([]);
        expect(match.missed).toEqual(["seeded-mechanism"]);
    });
    it("keeps blocking findings inline and suppresses nitpicks", () => {
        const records = [
            finding("nit", "src/a.ts", 1, "nit"),
            finding("blocking", "src/a.ts", 1, "blocking"),
        ];
        records[0]!.labelOverride = "nitpick (non-blocking)";
        records[1]!.finding.severity = "blocking";
        const c = corpus("blocking", [{path: "src/a.ts", line: 1}], records);
        const result = runCase(c, {
            posting: {depth: "full", nonBlockingInlineBudget: 0},
        });
        expect(result.posting).toEqual({
            inlineIds: ["blocking"],
            collapsedIds: ["nit"],
        });
    });
    it("counts a clean-case false flag even when it collapses", async () => {
        const c = corpus(
            "trap",
            [{path: "src/a.ts", line: 1}],
            [finding("false", "src/a.ts", 1, "trap")],
        );
        c.category = "clean";
        c.live!.mustNotFlagSpecs = c.live!.mustCatchSpecs;
        c.live!.mustCatchSpecs = [];
        const result = runCase(c, {
            posting: {depth: "full", nonBlockingInlineBudget: 0},
        });
        const match = await matchCase(c, result);
        expect(result.plannedReview.comments).toEqual([]);
        expect(match.falseFlags).toHaveLength(1);
    });
});

describe("useful-catch value controls", () => {
    const keys = ["lost", "shared", "gained-a", "gained-b"];
    const cases = keys.map((key) =>
        corpus(key, [{path: "src/a.ts", line: 1}], []),
    );
    const arm = (
        name: "baseline" | "candidate",
        caught: string[],
        usd: number,
        maxUsd = 10,
    ) =>
        runArm(
            name,
            cases,
            async (c) => ({
                findings: caught.includes(c.id)
                    ? [finding(c.id, "src/a.ts", 1, c.id)]
                    : [],
                validation: [],
                perAgent: [
                    {
                        name: "scripted",
                        model: "scripted",
                        usd,
                        turns: 1,
                        wallMs: 1,
                        retried: false,
                    },
                ],
            }),
            {maxUsd, log: () => {}},
        );

    it.each([
        {
            caught: ["shared", "gained-a", "gained-b"],
            gained: 2,
            net: 1,
            price: 2,
        },
        {caught: ["shared", "gained-a"], gained: 1, net: 0, price: null},
        {caught: ["shared"], gained: 0, net: -1, price: null},
    ])(
        "prices $net net catches with a $price denominator result",
        async ({caught, gained, net, price}) => {
            const baseline = await arm("baseline", ["lost", "shared"], 0.25);
            const candidate = await arm("candidate", caught, 0.75);
            const value = compareUsefulCoverage(baseline, candidate);
            expect(value).toMatchObject({
                gained,
                lost: 1,
                net,
                usdDelta: 2,
                usdPerNetUsefulCatch: price,
                unpaired: [],
            });
            expect(value.paired).toHaveLength(4);
            expect(value.paired.find((c) => c.caseId === "lost")?.lost).toEqual(
                ["lost"],
            );
            expect(
                value.paired.find((c) => c.caseId === "shared")?.shared,
            ).toEqual(["shared"]);
            expect(value.paired.flatMap((c) => c.gained)).toEqual(
                caught.filter((key) => key !== "shared"),
            );
            expect(valueSummary(value).join("\n")).toContain(
                `Dispatch cost per net useful catch (list price): ${
                    price === null ? "n/a (net gain is not positive)" : "$2.00"
                }.`,
            );
        },
    );

    it("doesn't price skipped or unrecorded cases as lost catches", async () => {
        const baseline = await arm("baseline", keys, 0.25);
        const candidate = await arm("candidate", keys, 0.75, 0.75);
        const value = compareUsefulCoverage(baseline, candidate);
        expect(candidate.skippedCases).toEqual(keys.slice(1));
        expect(value).toMatchObject({
            gained: 0,
            lost: 0,
            net: 0,
            usdDelta: 0.5,
            usdPerNetUsefulCatch: null,
            unpaired: keys.slice(1),
        });
        expect(value.paired).toHaveLength(1);
        delete candidate.perCase[0]!.accounting;
        expect(compareUsefulCoverage(baseline, candidate)).toMatchObject({
            paired: [],
            unpaired: keys,
            usdDelta: 0,
            usdPerNetUsefulCatch: null,
        });
    });
});
