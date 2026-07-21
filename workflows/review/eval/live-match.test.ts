import {describe, it, expect} from "vitest";

import {loadLiveCorpus, parseCase, type LiveDefectSpec} from "./corpus/loader";
import {
    computeLiveMetrics,
    matchCase,
    matchesSpec,
    type LiveCaseRun,
} from "./live-match";
import {runCase, type RunCandidate} from "./runner";

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    "-const total = round(cents);",
    "+const total = subtotal * 1.08;",
    "+const rounded = total.toFixed(2);",
    " export {compute};",
    " // end",
    "",
].join("\n");

/** A minimal posted candidate for direct matchesSpec tests. */
const candidate = (over: Partial<RunCandidate> = {}): RunCandidate => ({
    id: "cand-1",
    source: "correctness",
    lens: "correctness",
    label: "issue (blocking)",
    blocking: true,
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    path: "src/a.ts",
    line: 1,
    body: "**issue (blocking):** float math",
    finding: {
        schema_version: 2,
        id: "cand-1",
        lens: "correctness",
        anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
        severity: "blocking",
        confidence: 0.8,
        evidence_trace: ["e"],
        failure_scenario:
            "totals computed in floating point drift by a cent on large carts.",
        producing_hunt: "h",
        model_authored_prose: "The tax total uses float math and rounds late.",
    },
    ...over,
});

const spec = (over: Partial<LiveDefectSpec> = {}): LiveDefectSpec => ({
    key: "bug-1",
    path: "src/a.ts",
    lineStart: 1,
    lineEnd: 3,
    mechanism: ["float(ing)?[- ]?point", "rounds? late"],
    ...over,
});

describe("matchesSpec", () => {
    it("matches on window overlap plus any mechanism alternate", () => {
        expect(matchesSpec(candidate(), spec())).toBe(true);
    });

    it("rejects a wrong path and a line outside the window", () => {
        expect(matchesSpec(candidate(), spec({path: "src/b.ts"}))).toBe(false);
        expect(
            matchesSpec(candidate(), spec({lineStart: 10, lineEnd: 12})),
        ).toBe(false);
    });

    it("rejects a location match whose mechanism does not agree", () => {
        expect(
            matchesSpec(candidate(), spec({mechanism: ["sql injection"]})),
        ).toBe(false);
    });

    it("blockingOnly specs reject non-blocking candidates", () => {
        // A must-not-flag trap guarding a documented deliberate pattern
        // should claim a finding that condemns the pattern as a defect, not
        // a non-blocking advisory that merely names it (the 2026-07-20 A/B
        // saw "log instead of an empty catch" suggestions score as false
        // flags on the batch-limit case).
        const trap = spec({blockingOnly: true});
        expect(matchesSpec(candidate(), trap)).toBe(true);
        const advisory = candidate({
            label: "suggestion (non-blocking)",
            blocking: false,
        });
        expect(matchesSpec(advisory, trap)).toBe(false);
        // Without the pin, severity is not consulted.
        expect(matchesSpec(advisory, spec())).toBe(true);
    });

    it("matches file anchors on path alone and pr anchors on mechanism alone", () => {
        const fileAnchored = candidate({
            anchor: {type: "file", path: "src/a.ts"},
        });
        expect(matchesSpec(fileAnchored, spec())).toBe(true);
        const prAnchored = candidate({anchor: {type: "pr"}});
        expect(matchesSpec(prAnchored, spec({path: "src/other.ts"}))).toBe(
            true,
        );
    });

    it("accepts an anchor at any altLocation, window and mechanism intact", () => {
        // The defect spans files (migration + hot query): an anchor at the
        // alternate site is a catch, not a miss.
        const alt = spec({
            path: "src/other.ts",
            lineStart: 1,
            lineEnd: 3,
            altLocations: [{path: "src/a.ts", lineStart: 1, lineEnd: 3}],
        });
        expect(matchesSpec(candidate(), alt)).toBe(true);
        // The alternate window still binds...
        expect(
            matchesSpec(
                candidate(),
                spec({
                    path: "src/other.ts",
                    altLocations: [
                        {path: "src/a.ts", lineStart: 10, lineEnd: 12},
                    ],
                }),
            ),
        ).toBe(false);
        // ...and so does the mechanism, wherever the finding anchors.
        expect(
            matchesSpec(candidate(), {...alt, mechanism: ["sql injection"]}),
        ).toBe(false);
        // An altLocation without a window accepts any line on its file.
        expect(
            matchesSpec(
                candidate({
                    anchor: {
                        type: "line",
                        path: "src/a.ts",
                        line: 99,
                        side: "RIGHT",
                    },
                }),
                spec({
                    path: "src/other.ts",
                    altLocations: [{path: "src/a.ts"}],
                }),
            ),
        ).toBe(true);
    });

    it("treats a malformed regex alternate as a literal substring", () => {
        expect(
            matchesSpec(candidate(), spec({mechanism: ["float math and ("]})),
        ).toBe(false);
        expect(
            matchesSpec(candidate(), spec({mechanism: ["uses float math"]})),
        ).toBe(true);
    });
});

/** Build a live case + deterministic run whose posted set we control. */
const liveRun = (over: {
    id?: string;
    category?: string;
    mustCatchSpecs?: LiveDefectSpec[];
    mustNotFlagSpecs?: LiveDefectSpec[];
    findings?: unknown[];
    expectedVerdict?: string;
}) => {
    const corpusCase = parseCase(
        {
            id: over.id ?? "match-case",
            tags: ["live"],
            category: over.category ?? "incident-repro",
            description: "matcher fixture",
            changedFiles: [{path: "src/a.ts", status: "modified"}],
            expected: {verdict: over.expectedVerdict ?? "REQUEST_CHANGES"},
            diff: DIFF,
            findings: (over.findings ?? []).map((finding) => ({
                source: "correctness",
                finding,
            })),
            live: {
                prContext: {
                    title: "t",
                    description: "",
                    author: "a",
                    baseBranch: "main",
                },
                ...(over.mustCatchSpecs
                    ? {mustCatchSpecs: over.mustCatchSpecs}
                    : {}),
                ...(over.mustNotFlagSpecs
                    ? {mustNotFlagSpecs: over.mustNotFlagSpecs}
                    : {}),
            },
        },
        `test://${over.id ?? "match-case"}`,
    );
    return {corpusCase, result: runCase(corpusCase)};
};

const finding = (id: string, prose: string, severity = "blocking") => ({
    schema_version: 2,
    id,
    lens: "correctness",
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    severity,
    confidence: 0.8,
    evidence_trace: ["e"],
    failure_scenario: prose,
    producing_hunt: "h",
    model_authored_prose: prose,
});

describe("retention-dedup-window-untested spec (drift run 29724668102 regressions)", () => {
    // That run exposed two matching failures on this spec. The reviewer's
    // real dedup-coverage finding anchors on the TEST file, and the spec's
    // only location was retention.ts, so it could never match and was
    // recorded as a true miss. Meanwhile the Haiku arbiter accepted the
    // unrelated cap off-by-one finding for this spec three times (recorded
    // via: "fallback"), inflating the catch rate with a non-match. Both
    // recorded findings are pinned here (quoted from the run artifact,
    // punctuation lightly normalized) against the spec as loaded from the
    // corpus, so the fixed spec keeps matching the real finding
    // deterministically and never matches the arbiter's false accept.
    const dedupSpec = loadLiveCorpus()
        .find((c) => c.id === "golden-retention-lifecycle-2")
        ?.live?.mustCatchSpecs?.find(
            (s) => s.key === "retention-dedup-window-untested",
        );
    if (dedupSpec === undefined) {
        throw new Error(
            "retention-dedup-window-untested spec missing from the corpus",
        );
    }

    const coverageFinding = candidate({
        anchor: {
            type: "line",
            path: "src/notes/retention.test.ts",
            line: 5,
            side: "RIGHT",
        },
        path: "src/notes/retention.test.ts",
        line: 5,
        finding: {
            ...candidate().finding,
            anchor: {
                type: "line",
                path: "src/notes/retention.test.ts",
                line: 5,
                side: "RIGHT",
            },
            failure_scenario:
                "The off-by-one at retention.ts:38 or a broken prune would " +
                "ship undetected because this test, despite its name, saves " +
                "only 2 notes (cap is 200) and asserts only that pruneNotes " +
                "resolves; it never exceeds the cap nor checks the " +
                "surviving count.",
            model_authored_prose:
                "Test does not exercise the cap or dedup it claims to " +
                "cover. Add a test that saves more than MAX_NOTES_PER_USER " +
                "notes and asserts the retained count equals the cap, plus " +
                "a dedup test asserting a duplicate is not stored; " +
                "otherwise the core new behavior is untested.",
        },
    });

    const arbiterFalseAccept = candidate({
        anchor: {
            type: "line",
            path: "src/notes/retention.ts",
            line: 38,
            side: "RIGHT",
        },
        path: "src/notes/retention.ts",
        line: 38,
        finding: {
            ...candidate().finding,
            anchor: {
                type: "line",
                path: "src/notes/retention.ts",
                line: 38,
                side: "RIGHT",
            },
            failure_scenario:
                "A user accumulates 201 notes; pruneNotes queries with " +
                "offset 201 (MAX_NOTES_PER_USER + 1) against a newest-first " +
                "result, which returns zero stale rows, so nothing is " +
                "deleted and 201 notes remain, one over the intended hard " +
                "cap of 200.",
            model_authored_prose:
                "Off-by-one: offset MAX_NOTES_PER_USER + 1 lets the cap " +
                "reach 201. To keep exactly 200 newest notes (indices " +
                "0-199) the query must skip 200 and return index 200+, so " +
                "offset should be MAX_NOTES_PER_USER, not +1; the current " +
                "+1 permanently retains one extra note per user.",
        },
    });

    it("matches the recorded test-file coverage finding deterministically", () => {
        expect(matchesSpec(coverageFinding, dedupSpec)).toBe(true);
    });

    it("never matches the off-by-one finding the arbiter wrongly accepted", () => {
        expect(matchesSpec(arbiterFalseAccept, dedupSpec)).toBe(false);
    });
});

describe("matchCase", () => {
    it("reports caught, missed, and unmatched findings", async () => {
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({key: "float-bug"}),
                spec({key: "never-found", mechanism: ["deadlock"]}),
            ],
            findings: [
                finding("f-float", "floating point totals round late."),
                finding("f-noise", "the variable name is unclear.", "advisory"),
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught).toEqual([
            {specKey: "float-bug", findingId: "f-float", via: "deterministic"},
        ]);
        expect(match.missed).toEqual(["never-found"]);
        expect(match.unmatchedFindingIds).toEqual(["f-noise"]);
        expect(match.postedCount).toBe(2);
    });

    it("never lets one candidate satisfy two specs", async () => {
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "first"}), spec({key: "second"})],
            findings: [finding("f-only", "floating point rounds late.")],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.length).toBe(1);
        expect(match.missed).toEqual(["second"]);
    });

    it("flags must-not-flag specs deterministically", async () => {
        const {corpusCase, result} = liveRun({
            mustNotFlagSpecs: [
                spec({key: "trap", mechanism: ["500.entity|batch cap"]}),
            ],
            findings: [
                finding("f-trap", "the delete exceeds the 500-entity cap."),
            ],
            expectedVerdict: "REQUEST_CHANGES",
        });
        const match = await matchCase(corpusCase, result);
        expect(match.falseFlags[0]?.specKey).toBe("trap");
        expect(match.unmatchedFindingIds).toEqual([]);
    });

    it("uses the capped fallback only for same-file leftovers and records it", async () => {
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "subtle", mechanism: ["off.by.one"]})],
            findings: [
                finding("f-vague", "the loop boundary looks wrong here."),
            ],
        });
        const calls: string[] = [];
        const match = await matchCase(corpusCase, result, {
            fallback: async (cand, s) => {
                calls.push(`${cand.id}->${s.key}`);
                return true;
            },
        });
        expect(calls).toEqual(["f-vague->subtle"]);
        expect(match.caught).toEqual([
            {specKey: "subtle", findingId: "f-vague", via: "fallback"},
        ]);

        const capped = await matchCase(corpusCase, result, {
            fallback: async () => true,
            maxFallbackCalls: 0,
        });
        expect(capped.missed).toEqual(["subtle"]);
    });

    it("catches a near-miss mis-anchor via anchor-snap and flips back under anchorSnap: false", async () => {
        // The DIFF's changed lines are 1-2; line 4 is a near-miss (within
        // the snap window), the observed right-file, right-mechanism,
        // wrong-line pathology. With the snap (production default) the
        // blocking finding posts at the snapped line, matches the spec, and
        // drives the verdict; emulating a pre-snap arm drops it at the gate
        // and the verdict flips — the exact failure anchor-snap removes.
        const misAnchored = {
            ...finding("f-snapped", "floating point totals round late."),
            anchor: {type: "line", path: "src/a.ts", line: 4, side: "RIGHT"},
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            findings: [misAnchored],
        });
        expect(result.snappedByProvenance).toHaveLength(1);
        expect(result.snappedByProvenance[0]?.candidate.line).toBe(2);
        expect(result.snappedByProvenance[0]?.originalAnchor).toEqual({
            type: "line",
            path: "src/a.ts",
            line: 4,
            side: "RIGHT",
        });
        expect(result.droppedByProvenance).toEqual([]);
        expect(result.verdict.event).toBe("REQUEST_CHANGES");
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.specKey)).toEqual(["float-bug"]);

        const preSnap = runCase(corpusCase, {anchorSnap: false});
        expect(preSnap.snappedByProvenance).toEqual([]);
        expect(preSnap.droppedByProvenance.map((c) => c.id)).toEqual([
            "f-snapped",
        ]);
        expect(preSnap.verdict.event).toBe("APPROVE");
        const preSnapMatch = await matchCase(corpusCase, preSnap);
        expect(preSnapMatch.missedDetail).toEqual([
            {
                specKey: "float-bug",
                droppedBy: "provenance",
                findingId: "f-snapped",
            },
        ]);
    });

    it("classifies a produced-then-dropped miss by its gate bucket", async () => {
        // The finding names the right mechanism but anchors off the diff, so
        // the provenance gate drops it before posting: a found-but-dropped
        // miss, not a true recall miss.
        const offDiff = {
            ...finding("f-dropped", "floating point totals round late."),
            anchor: {type: "line", path: "src/a.ts", line: 40, side: "RIGHT"},
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({key: "float-bug"}),
                spec({key: "never-found", mechanism: ["deadlock"]}),
            ],
            findings: [offDiff],
        });
        expect(result.droppedByProvenance.map((c) => c.id)).toEqual([
            "f-dropped",
        ]);
        const match = await matchCase(corpusCase, result);
        expect(match.missed).toEqual(["float-bug", "never-found"]);
        expect(match.missedDetail).toEqual([
            {
                specKey: "float-bug",
                droppedBy: "provenance",
                findingId: "f-dropped",
            },
            {specKey: "never-found"},
        ]);
    });
});

describe("computeLiveMetrics", () => {
    it("aggregates recall, verdict agreement, noise, and clean false flags", async () => {
        const incident = liveRun({
            id: "case-incident",
            mustCatchSpecs: [
                spec({key: "hit"}),
                spec({key: "miss", mechanism: ["deadlock"]}),
            ],
            findings: [
                finding("f-hit", "floating point rounds late."),
                finding("f-extra", "naming could be better.", "advisory"),
            ],
        });
        // A clean case that wrongly blocks.
        const clean = liveRun({
            id: "case-clean",
            category: "clean",
            expectedVerdict: "APPROVE",
            findings: [finding("f-block", "this blocks for no reason.")],
        });
        const runs: LiveCaseRun[] = [];
        for (const {corpusCase, result} of [incident, clean]) {
            runs.push({
                corpusCase,
                result,
                match: await matchCase(corpusCase, result),
            });
        }
        const metrics = computeLiveMetrics(runs);
        expect(metrics.caseCount).toBe(2);
        expect(metrics.mustCatchRecall).toEqual({
            numerator: 1,
            denominator: 2,
            rate: 0.5,
        });
        // incident expected REQUEST_CHANGES and blocked: agreement; clean
        // expected APPROVE but blocked: disagreement.
        expect(metrics.verdictAgreement.numerator).toBe(1);
        expect(metrics.cleanFalseFlag.details).toContain(
            "case-clean:blocked-clean-case",
        );
        // Noise: f-extra and f-block matched nothing (3 posted total).
        expect(metrics.noise).toEqual({
            numerator: 2,
            denominator: 3,
            rate: 2 / 3,
        });
    });
});
