import {describe, it, expect} from "vitest";

import {
    CASE_CATEGORIES,
    SMOKE_TAG,
    loadCorpus,
    loadSmokeCorpus,
    parseCase,
    type CaseExpectation,
    type CorpusCase,
} from "./corpus/loader.ts";
import {runCase} from "./runner.ts";
import type {EvalRun} from "./run-types.ts";
import {
    CALIBRATION_BUCKETS,
    calibration,
    cleanFalseBlock,
    computeMetrics,
    goldenPrecision,
    mustCatchRecall,
    noise,
} from "./metrics.ts";
import {
    TAG_ADVERSARIAL,
    TAG_HOLDOUT,
    adversarialGate,
    checkExpectation,
    evaluateGates,
    overfittingReport,
} from "./gates.ts";
import {
    DEFAULT_AUDIT_SIZE,
    PINNED_JUDGE_MODEL,
    aggregate,
    buildCorpusRequests,
    calibrateAgainstThumbs,
    judgeCorpus,
    selectAuditSample,
    type JudgeModel,
    type JudgeReport,
    type JudgeRequest,
    type JudgeScore,
    type ThumbsLabel,
} from "./judge.ts";
import {
    VERSION_MARKER_KEY,
    VERSION_STAMP_FORMAT,
    canonicalize,
    computeVersionStamp,
    hasDrifted,
    parseVersionMarker,
    renderVersionMarker,
} from "../lib/version-stamp.ts";
import {
    FINDING_SCHEMA_VERSION,
    type Lens,
    type Severity,
} from "../lib/finding-schema.ts";

/**
 * Full eval-suite **self-tests** + CI-wiring guard (TASK-11-6).
 *
 * This file has two halves:
 *
 *   1. **Suite self-tests.** The eval suite ships as five
 *      leaf modules — the shared corpus `loader`, the deterministic no-post
 *      `runner`, the five `metrics`, the overfitting/adversarial `gates`, the
 *      LLM-`judge`, and the reviewer `version-stamp`. This file is the harness
 *      that keeps them honest: it exercises each over the *real* four-dataset
 *      corpus plus focused synthetic fixtures, so a regression in a metric, a
 *      gate, the judge's aggregation, or the drift stamp fails a test rather than
 *      silently corrupting a scheduled eval run.
 *
 *   2. **Wire the smoke subset as the per-PR CI gate; the full suite as
 *      scheduled (not per-PR).** The smoke subset is already the `pnpm test`
 *      gate (`smoke.test.ts`, and the staged `.github-staging/
 *      review-smoke.yml`). What this file additionally *enforces* is the property
 *      that makes that split safe: everything the per-PR gate runs is
 *      deterministic and model-free — the ONLY model seam in the whole suite is
 *      the judge, which takes an injected {@link JudgeModel} and is never called
 *      at import or on the deterministic path. So the metrics + gates run over the
 *      full corpus per-PR with zero network, while the *live-judge* full run is
 *      opt-in and belongs to a scheduled job. These tests use a stub judge model;
 *      they never call a real model.
 *
 * This is a CONSUMER of the suite modules, not a re-implementation:
 * every assertion drives the public exports of the modules under test.
 *
 * Determinism: no model, no network, no clock, no randomness. The judge is
 * stubbed; the version stamp and metrics are pure; the corpus is read from disk
 * through the same shared loader the runner uses.
 */

/* -------------------------------------------------------------------------- */
/* Fixture factories — build type-correct EvalRuns via the PUBLIC case path.  */
/* -------------------------------------------------------------------------- */

/**
 * Build a valid finding JSON (schema-versioned). PR-anchored by default so it is
 * never dropped by the newly-changed-code scope filter — fixtures control the
 * posted set through `findings`/`scope`, not through anchor accidents.
 */
type FindingOverrides = {
    id?: string;
    lens?: Lens;
    severity?: Severity;
    confidence?: number;
    anchor?: Record<string, unknown>;
};
const finding = (over: FindingOverrides = {}): Record<string, unknown> => ({
    schema_version: FINDING_SCHEMA_VERSION,
    id: over.id ?? "f",
    lens: over.lens ?? "correctness",
    anchor: over.anchor ?? {type: "pr"},
    severity: over.severity ?? "advisory",
    confidence: over.confidence ?? 0.5,
    evidence_trace: ["synthetic evidence line"],
    producing_hunt: "test:hunt",
    model_authored_prose: "Synthetic finding prose for the eval self-tests.",
});

type CaseOverrides = {
    id?: string;
    tags?: string[];
    category?: CorpusCase["category"];
    findings?: {source: string; finding: Record<string, unknown>}[];
    dimensions?: Record<string, string>;
    scope?: Record<string, unknown>;
    expected?: CaseExpectation;
    changedFiles?: {path: string; status: string}[];
    policyConflicts?: {policy: string; detail: string}[];
};

let caseSeq = 0;
const makeCase = (over: CaseOverrides = {}): CorpusCase => {
    const id = over.id ?? `synthetic-${(caseSeq += 1)}`;
    const raw: Record<string, unknown> = {
        id,
        tags: over.tags ?? ["synthetic"],
        category: over.category ?? "incident-repro",
        description: "synthetic self-test case",
        changedFiles: over.changedFiles ?? [
            {path: "src/x.ts", status: "modified"},
        ],
        findings: over.findings ?? [],
        policyConflicts: over.policyConflicts ?? [],
        expected: over.expected ?? {verdict: "APPROVE"},
    };
    if (over.dimensions !== undefined) {
        raw["dimensions"] = over.dimensions;
    }
    if (over.scope !== undefined) {
        raw["scope"] = over.scope;
    }
    return parseCase(raw, `test://${id}`);
};

/** A corpus case plus the deterministic run over it — a real, type-correct EvalRun. */
const makeRun = (over: CaseOverrides = {}): EvalRun => {
    const corpusCase = makeCase(over);
    return {corpusCase, result: runCase(corpusCase)};
};

/** Pair a loaded case list with deterministic runs — the full-suite input shape. */
const runAll = (cases: CorpusCase[]): EvalRun[] =>
    cases.map((corpusCase) => ({corpusCase, result: runCase(corpusCase)}));

/* -------------------------------------------------------------------------- */
/* The real corpus, loaded + run once (shared by the whole-suite assertions).  */
/* -------------------------------------------------------------------------- */

const FULL_CASES: CorpusCase[] = loadCorpus();
const FULL_RUNS: EvalRun[] = runAll(FULL_CASES);
const SMOKE_CASES: CorpusCase[] = loadSmokeCorpus();

/* -------------------------------------------------------------------------- */
/* 1. Four datasets load via the shared loader; smoke is a strict subset.      */
/* -------------------------------------------------------------------------- */

describe("full corpus: four datasets load via the one shared loader", () => {
    it("loads a corpus strictly larger than the smoke subset", () => {
        expect(FULL_CASES.length).toBeGreaterThan(SMOKE_CASES.length);
    });

    it("covers the four datasets + the adversarial set", () => {
        const categories = new Set(FULL_CASES.map((c) => c.category));
        // The four datasets the operator named (incident repros, synthetic
        // mutations, golden human-comment set, clean set) plus the adversarial
        // set the hard gate consumes.
        for (const required of [
            "incident-repro",
            "synthetic-mutation",
            "golden",
            "clean",
            "adversarial-injection",
        ] as const) {
            expect(categories.has(required)).toBe(true);
        }
        for (const category of categories) {
            expect(CASE_CATEGORIES).toContain(category);
        }
    });

    it("has globally unique case ids across every dataset", () => {
        const ids = FULL_CASES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("smoke subset ⊂ full corpus, and every smoke case carries the smoke tag", () => {
        const fullIds = new Set(FULL_CASES.map((c) => c.id));
        expect(SMOKE_CASES.length).toBeGreaterThan(0);
        for (const smoke of SMOKE_CASES) {
            expect(smoke.tags).toContain(SMOKE_TAG);
            expect(fullIds.has(smoke.id)).toBe(true);
        }
    });

    it("carries a holdout split and an adversarial set for the gates", () => {
        const holdout = FULL_CASES.filter((c) => c.tags.includes(TAG_HOLDOUT));
        const adversarial = FULL_CASES.filter(
            (c) =>
                c.tags.includes(TAG_ADVERSARIAL) ||
                c.category === "adversarial-injection",
        );
        expect(holdout.length).toBeGreaterThan(0);
        expect(adversarial.length).toBeGreaterThan(0);
    });
});

/* -------------------------------------------------------------------------- */
/* 2. The full suite is INVOCABLE and green on baseline (deterministic path).  */
/* -------------------------------------------------------------------------- */

describe("full suite runs green on baseline ('full suite invocable')", () => {
    it.each(FULL_RUNS)(
        "$corpusCase.id meets its expected block exactly",
        (run) => {
            expect(checkExpectation(run)).toEqual([]);
        },
    );

    it("computes must-catch recall = 100% and clean false-block = 0 over the whole corpus", () => {
        const report = computeMetrics(FULL_RUNS);
        expect(report.caseCount).toBe(FULL_RUNS.length);
        // Recall must be exercised (non-vacuous) and perfect on baseline.
        expect(report.mustCatchRecall.denominator).toBeGreaterThan(0);
        expect(report.mustCatchRecall.rate).toBe(1);
        // A clean PR must never be blocked.
        expect(report.cleanFalseBlock.denominator).toBeGreaterThan(0);
        expect(report.cleanFalseBlock.rate).toBe(0);
    });

    it("passes the adversarial hard gate on baseline (automatic mode allowed)", () => {
        const gates = evaluateGates(FULL_RUNS);
        expect(gates.adversarial.total).toBeGreaterThan(0);
        expect(gates.adversarial.failures).toEqual([]);
        expect(gates.automaticModeAllowed).toBe(true);
        // The overfitting report rides along with a real holdout split.
        expect(gates.overfitting.holdoutSize).toBeGreaterThan(0);
        expect(gates.overfitting.trainingSize).toBeGreaterThan(0);
    });
});

/* -------------------------------------------------------------------------- */
/* 3. The five metrics — focused fixtures.                         */
/* -------------------------------------------------------------------------- */

describe("metrics self-tests: five numbers computed deterministically", () => {
    it("must-catch recall counts posted vs. dropped required ids", () => {
        // Finding "a" is posted; "b" is required but absent -> 1/2.
        const run = makeRun({
            findings: [{source: "correctness", finding: finding({id: "a"})}],
            expected: {verdict: "APPROVE", mustCatch: ["a", "b"]},
        });
        const m = mustCatchRecall([run]);
        expect(m.numerator).toBe(1);
        expect(m.denominator).toBe(2);
        expect(m.rate).toBe(0.5);
        expect(m.misses).toContain(`${run.corpusCase.id}:b`);
    });

    it("must-catch recall is 0 with an empty denominator (no must-catch cases)", () => {
        expect(mustCatchRecall([]).rate).toBe(0);
        expect(mustCatchRecall([]).denominator).toBe(0);
    });

    it("golden precision counts posted findings against human ground truth", () => {
        // Golden case: two advisory findings posted; only "hit" is human-flagged.
        const run = makeRun({
            category: "golden",
            findings: [
                {
                    source: "content-i18n",
                    finding: finding({id: "hit", lens: "content-i18n"}),
                },
                {
                    source: "conventions",
                    finding: finding({id: "extra", lens: "conventions"}),
                },
            ],
            expected: {
                verdict: "APPROVE",
                mustCatch: ["hit"],
                postedCommentCount: 2,
            },
        });
        const m = goldenPrecision([run]);
        expect(m.numerator).toBe(1);
        expect(m.denominator).toBe(2);
        expect(m.rate).toBe(0.5);
    });

    it("clean false-block is 1 when a clean case blocks, 0 when it approves", () => {
        const blocked = makeRun({
            category: "clean",
            findings: [
                {
                    source: "correctness",
                    finding: finding({
                        id: "bug",
                        severity: "blocking",
                        confidence: 0.9,
                    }),
                },
            ],
            expected: {verdict: "REQUEST_CHANGES"},
        });
        expect(blocked.result.verdict.event).toBe("REQUEST_CHANGES");
        expect(cleanFalseBlock([blocked]).rate).toBe(1);

        const passed = makeRun({
            category: "clean",
            expected: {verdict: "APPROVE"},
        });
        expect(cleanFalseBlock([passed]).rate).toBe(0);
    });

    it("noise counts posted comments the case marked must-not-post", () => {
        const run = makeRun({
            findings: [{source: "correctness", finding: finding({id: "n"})}],
            expected: {verdict: "APPROVE", mustNotPost: ["n"]},
        });
        const m = noise([run]);
        expect(m.numerator).toBe(1);
        expect(m.denominator).toBe(1);
        expect(m.rate).toBe(1);
    });

    it("calibration buckets labelled findings and computes ECE; null when unlabelled", () => {
        // A correct and an incorrect finding, both confidence 0.9 -> one bucket,
        // meanConfidence 0.9, accuracy 0.5 -> ECE 0.4.
        const run = makeRun({
            findings: [
                {
                    source: "correctness",
                    finding: finding({id: "hit", confidence: 0.9}),
                },
                {
                    source: "correctness",
                    finding: finding({id: "miss", confidence: 0.9}),
                },
            ],
            expected: {
                verdict: "APPROVE",
                mustCatch: ["hit"],
                mustNotPost: ["miss"],
            },
        });
        const c = calibration([run]);
        expect(c.buckets.length).toBe(CALIBRATION_BUCKETS);
        expect(c.sampleSize).toBe(2);
        expect(c.ece).toBeCloseTo(0.4, 10);

        // No labelled posted findings -> nothing to calibrate.
        const unlabelled = makeRun({
            findings: [
                {
                    source: "correctness",
                    finding: finding({id: "x", confidence: 0.7}),
                },
            ],
            expected: {verdict: "APPROVE"},
        });
        expect(calibration([unlabelled]).ece).toBeNull();
    });
});

/* -------------------------------------------------------------------------- */
/* 4. Gates: adversarial hard gate + overfitting report.           */
/* -------------------------------------------------------------------------- */

describe("gates self-tests: adversarial hard gate + overfitting split", () => {
    it("checkExpectation surfaces each failure code", () => {
        // Expect REQUEST_CHANGES + a must-catch that the advisory run drops, and a
        // pinned comment count that will not match.
        const run = makeRun({
            findings: [
                {source: "correctness", finding: finding({id: "posted"})},
            ],
            expected: {
                verdict: "REQUEST_CHANGES",
                mustCatch: ["never-posted"],
                mustNotPost: ["posted"],
                postedCommentCount: 5,
            },
        });
        const codes = checkExpectation(run)
            .map((f) => f.code)
            .sort();
        expect(codes).toEqual(
            [
                "comment-count-mismatch",
                "must-catch-dropped",
                "must-not-post-emitted",
                "wrong-verdict",
            ].sort(),
        );
    });

    it("adversarial gate fails (automatic mode blocked) when an adversarial case is mishandled", () => {
        // An adversarial case that SHOULD block, but the run only has an advisory
        // finding -> APPROVE -> wrong verdict -> gate fails.
        const manipulated = makeRun({
            category: "adversarial-injection",
            tags: ["adversarial"],
            findings: [
                {
                    source: "security-auth",
                    finding: finding({id: "sink", lens: "security-auth"}),
                },
            ],
            expected: {verdict: "REQUEST_CHANGES", mustCatch: ["sink"]},
        });
        const gate = adversarialGate([manipulated]);
        expect(gate.total).toBe(1);
        expect(gate.passed).toBe(false);
        expect(gate.failures[0]?.caseId).toBe(manipulated.corpusCase.id);
        expect(evaluateGates([manipulated]).automaticModeAllowed).toBe(false);
    });

    it("overfitting report splits holdout vs. training and reports the sizes", () => {
        const holdoutRun = makeRun({
            tags: ["synthetic", TAG_HOLDOUT],
            findings: [
                {
                    source: "correctness",
                    finding: finding({
                        id: "h",
                        severity: "blocking",
                        confidence: 0.9,
                    }),
                },
            ],
            expected: {verdict: "REQUEST_CHANGES", mustCatch: ["h"]},
        });
        const trainRun = makeRun({
            findings: [
                {
                    source: "correctness",
                    finding: finding({
                        id: "t",
                        severity: "blocking",
                        confidence: 0.9,
                    }),
                },
            ],
            expected: {verdict: "REQUEST_CHANGES", mustCatch: ["t"]},
        });
        const report = overfittingReport([holdoutRun, trainRun]);
        expect(report.holdoutSize).toBe(1);
        expect(report.trainingSize).toBe(1);
        expect(typeof report.recallGap).toBe("number");
        expect(typeof report.precisionGap).toBe("number");
    });
});

/* -------------------------------------------------------------------------- */
/* 5. Judge: a STUB model — never a live call.                     */
/* -------------------------------------------------------------------------- */

/** A deterministic stub judge: verdict/quality driven by a per-findingId table. */
const stubModel =
    (
        table: Record<
            string,
            {verdict: JudgeScore["verdict"]; quality: number}
        >,
        fallback: {verdict: JudgeScore["verdict"]; quality: number} = {
            verdict: "good",
            quality: 0.8,
        },
    ): JudgeModel =>
    async (requests: JudgeRequest[]): Promise<JudgeScore[]> =>
        requests.map((r) => {
            const scored = table[r.findingId] ?? fallback;
            return {
                findingId: r.findingId,
                verdict: scored.verdict,
                quality: scored.quality,
                rationale: "stub",
            };
        });

describe("judge self-tests: pure aggregation around a stubbed model", () => {
    it("pins the judge model to Opus 4.8 (operator direction 4)", () => {
        expect(PINNED_JUDGE_MODEL).toBe("claude-opus-4-8");
    });

    it("builds one request per posted comment across the corpus", () => {
        const runs = [
            makeRun({
                findings: [
                    {source: "correctness", finding: finding({id: "a"})},
                ],
                expected: {verdict: "APPROVE"},
            }),
            makeRun({
                findings: [
                    {source: "correctness", finding: finding({id: "b"})},
                ],
                expected: {verdict: "APPROVE"},
            }),
        ];
        const requests = buildCorpusRequests(runs);
        expect(requests.map((r) => r.findingId).sort()).toEqual(["a", "b"]);
    });

    it("aggregate throws when the model drops a score", () => {
        const requests = buildCorpusRequests([
            makeRun({
                findings: [
                    {source: "correctness", finding: finding({id: "a"})},
                ],
                expected: {verdict: "APPROVE"},
            }),
        ]);
        expect(() => aggregate(requests, [])).toThrow(/no score/i);
    });

    it("flags judge-vs-corpus disagreements (must-catch judged bad; non-catch judged good)", async () => {
        const run = makeRun({
            findings: [
                {source: "correctness", finding: finding({id: "catch"})},
                {source: "correctness", finding: finding({id: "nit"})},
            ],
            expected: {verdict: "APPROVE", mustCatch: ["catch"]},
        });
        const requests = buildCorpusRequests([run]);
        const scores = await stubModel({
            catch: {verdict: "bad", quality: 0.1}, // a must-catch the judge dislikes
            nit: {verdict: "good", quality: 0.9}, // a non-must-catch the judge likes
        })(requests);
        const report = aggregate(requests, scores);
        const disagreementIds = report.disagreements
            .map((d) => d.request.findingId)
            .sort();
        expect(disagreementIds).toEqual(["catch", "nit"]);
        expect(report.meanQuality).toBeCloseTo(0.5, 10);
        expect(report.verdictCounts.bad).toBe(1);
        expect(report.verdictCounts.good).toBe(1);
    });

    it("selectAuditSample is deterministic, disagreement-first, and size-capped", () => {
        const scored = (
            findingId: string,
            verdict: JudgeScore["verdict"],
            gt: boolean,
        ) => ({
            request: {
                caseId: "c",
                findingId,
                lens: "correctness",
                label: "issue",
                context: "ctx",
                commentBody: "body",
                evidenceTrace: ["e"],
                groundTruthCatch: gt,
            },
            score: {findingId, verdict, quality: 0.5, rationale: "r"},
        });
        // "d" is a disagreement (good but not ground-truth catch); "b" borderline;
        // "g" a plain good.
        const report: JudgeReport = {
            scored: [
                scored("g", "good", true),
                scored("b", "borderline", true),
                scored("d", "good", false),
            ],
            meanQuality: 0.5,
            verdictCounts: {good: 2, borderline: 1, bad: 0},
            disagreements: [scored("d", "good", false)],
        };
        const sample = selectAuditSample(report, 2);
        expect(sample.length).toBe(2);
        expect(sample[0]?.request.findingId).toBe("d"); // disagreement first
        expect(sample[1]?.request.findingId).toBe("b"); // then borderline
        // Deterministic: same inputs -> identical selection.
        expect(
            selectAuditSample(report, 2).map((s) => s.request.findingId),
        ).toEqual(sample.map((s) => s.request.findingId));
        expect(DEFAULT_AUDIT_SIZE).toBeGreaterThan(0);
    });

    it("calibrates against thumbs: agreement, conflicts, borderline excluded, null on no overlap", () => {
        const scored = (findingId: string, verdict: JudgeScore["verdict"]) => ({
            request: {
                caseId: "c",
                findingId,
                lens: "correctness" as const,
                label: "issue",
                context: "ctx",
                commentBody: "body",
                evidenceTrace: ["e"],
                groundTruthCatch: true,
            },
            score: {findingId, verdict, quality: 0.5, rationale: "r"},
        });
        const report: JudgeReport = {
            scored: [
                scored("agree", "good"),
                scored("conflict", "bad"),
                scored("bord", "borderline"),
            ],
            meanQuality: 0.5,
            verdictCounts: {good: 1, borderline: 1, bad: 1},
            disagreements: [],
        };
        const thumbs: ThumbsLabel[] = [
            {findingId: "agree", direction: "up"}, // judge good ↔ 👍 => agree
            {findingId: "conflict", direction: "up"}, // judge bad ↔ 👍 => conflict
            {findingId: "bord", direction: "down"}, // borderline => excluded
        ];
        const cal = calibrateAgainstThumbs(report, thumbs);
        expect(cal.comparedCount).toBe(2); // borderline excluded
        expect(cal.agreementRate).toBe(0.5);
        expect(cal.conflicts.map((c) => c.findingId)).toEqual(["conflict"]);

        expect(calibrateAgainstThumbs(report, []).agreementRate).toBeNull();
    });

    it("judgeCorpus runs end-to-end with a stub model and surfaces an audit sample", async () => {
        const run = makeRun({
            findings: [{source: "correctness", finding: finding({id: "a"})}],
            expected: {verdict: "APPROVE", mustCatch: ["a"]},
        });
        const result = await judgeCorpus([run], stubModel({}), {
            thumbs: [{findingId: "a", direction: "up"}],
        });
        expect(result.report.scored.length).toBe(1);
        expect(result.auditSample.length).toBeGreaterThan(0);
        expect(result.thumbsCalibration?.comparedCount).toBe(1);
    });
});

/* -------------------------------------------------------------------------- */
/* 6. Version stamp: the single drift-guard surface.               */
/* -------------------------------------------------------------------------- */

describe("version stamp self-tests: the one drift-guard surface", () => {
    const base = {prompts: {"review.md": "v1"}, config: {effort: "high"}};

    it("changes when the prompt, the config, or the schema version changes", () => {
        const stamp = computeVersionStamp(base);
        expect(
            computeVersionStamp({...base, prompts: {"review.md": "v2"}}),
        ).not.toBe(stamp);
        expect(
            computeVersionStamp({...base, config: {effort: "xhigh"}}),
        ).not.toBe(stamp);
        expect(
            computeVersionStamp({
                ...base,
                schemaVersion: FINDING_SCHEMA_VERSION + 1,
            }),
        ).not.toBe(stamp);
    });

    it("is stable under key reordering (content hash, not insertion order)", () => {
        const a = computeVersionStamp({
            config: {a: 1, b: 2},
            prompts: {x: "1", y: "2"},
        });
        const b = computeVersionStamp({
            prompts: {y: "2", x: "1"},
            config: {b: 2, a: 1},
        });
        expect(a).toBe(b);
        // canonicalize is the property that guarantees it.
        expect(canonicalize({a: 1, b: 2})).toBe(canonicalize({b: 2, a: 1}));
    });

    it("renders into the #194 HTML marker and round-trips through the parser", () => {
        const marker = renderVersionMarker(base);
        expect(marker).toContain(`<!-- ${VERSION_MARKER_KEY}`);
        const parsed = parseVersionMarker(`prefix\n${marker}\nsuffix`);
        expect(parsed).not.toBeNull();
        expect(parsed?.stamp).toBe(computeVersionStamp(base));
        expect(parsed?.format).toBe(VERSION_STAMP_FORMAT);
        expect(parsed?.schema).toBe(FINDING_SCHEMA_VERSION);
        expect(parseVersionMarker("no marker here")).toBeNull();
    });

    it("hasDrifted is the drift predicate a consumer sync check calls", () => {
        const stamp = computeVersionStamp(base);
        const drifted = computeVersionStamp({
            ...base,
            prompts: {"review.md": "v9"},
        });
        expect(hasDrifted(stamp, stamp)).toBe(false);
        expect(hasDrifted(stamp, drifted)).toBe(true);
    });
});

/* -------------------------------------------------------------------------- */
/* 7. CI wiring: smoke = per-PR gate; full suite = scheduled (not per-PR).      */
/* -------------------------------------------------------------------------- */

describe("CI wiring: smoke gates per-PR, live-judge suite is scheduled", () => {
    it("the smoke subset is a non-empty, strict subset — the per-PR gate stays fast", () => {
        // smoke.test.ts is the `pnpm test` gate; it must run a proper subset so the
        // per-PR job never pays for the full four-dataset corpus.
        expect(SMOKE_CASES.length).toBeGreaterThan(0);
        expect(SMOKE_CASES.length).toBeLessThan(FULL_CASES.length);
    });

    it("the whole deterministic suite (metrics + gates) runs per-PR with ZERO model calls", () => {
        // The property that makes 'full suite scheduled, not per-PR' safe: the
        // metrics and gates are synchronous, pure functions over the full corpus —
        // no promise, no model, no network. They are safe to run in any CI job.
        const report = computeMetrics(FULL_RUNS);
        const gates = evaluateGates(FULL_RUNS);
        expect(report.caseCount).toBe(FULL_RUNS.length);
        expect(gates.adversarial.total).toBeGreaterThan(0);
    });

    it("the ONLY model seam is the judge, which requires an injected model (never auto-called)", async () => {
        // judgeCorpus is async and takes a JudgeModel — the live model is opt-in,
        // supplied only by a scheduled job. Here we prove it composes with a stub
        // and returns a Promise (i.e. it is the async boundary, off the per-PR path).
        const pending = judgeCorpus(
            [
                makeRun({
                    findings: [
                        {source: "correctness", finding: finding({id: "a"})},
                    ],
                    expected: {verdict: "APPROVE"},
                }),
            ],
            stubModel({}),
        );
        expect(pending).toBeInstanceOf(Promise);
        const result = await pending;
        expect(result.report.scored.length).toBe(1);
    });
});
