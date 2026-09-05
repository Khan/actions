import {describe, it, expect} from "vitest";

import {
    applyMediumVeto,
    applyVerifications,
    buildClaims,
    contractValidator,
    joinProse,
    parseClustererOutput,
    parseFinderOutput,
    parseJsonObject,
    parseValidatorOutput,
    type Claim,
} from "./dispatch-contracts";
import {computeChangedLines} from "./diff";
import {labelForFinding} from "./render-comment";

/**
 * Contract-parse tests for the label-shape mapping (dispatch-contracts.ts),
 * split from dispatch.test.ts alongside the module split. These pin the
 * run-29897276810 fixes: the ReportFindings-shape near-miss salvage, the
 * label-contract rejection that feeds the malformed-output retry, and the
 * punctuation-aware subject/discussion join, plus the per-key validation
 * of the validator's `corrected` fields.
 */

const CORRECTNESS_OUT = JSON.stringify({
    findings: [
        {
            path: "a.ts",
            line: 2,
            label: "issue (blocking)",
            subject: "Broken guard.",
            discussion: "The guard was removed.",
            failure_scenario: "nil deref on empty input",
        },
    ],
    files: [{path: "a.ts", risk: "high"}],
});

const claim = (overrides: Partial<Claim> = {}): Claim =>
    ({
        id: "c1",
        source: "correctness-reviewer",
        path: "a.ts",
        line: 2,
        label: "issue (blocking)",
        subject: "s",
        discussion: "The guard was removed.",
        failure_scenario: "f",
        confidence: 0.9,
        ...overrides,
    } as Claim);

describe("label-contract enforcement (run 29897276810)", () => {
    it("salvages a ReportFindings-style near-miss that still carries a valid label", () => {
        // path lives in anchor/file, subject in summary (the run-29897276810
        // drift), but the label contract is honoured: salvage, don't reject.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        anchor: {path: "a.ts", line: 38},
                        file: "a.ts",
                        label: "issue (blocking)",
                        summary: "AddDate subtracts months, not days.",
                        discussion: "The signature is (years, months, days).",
                        failure_scenario: "nothing ever expires",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.anchor).toMatchObject({
            path: "a.ts",
            line: 38,
        });
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(candidates[0].finding.model_authored_prose).toBe(
            "AddDate subtracts months, not days. The signature is (years, months, days).",
        );
    });

    it("salvages a title-keyed subject (run 29908199997's drift shape)", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "unbounded-expiration-read",
                        file: "a.go",
                        anchor: {path: "a.go", line: 44},
                        label: "issue (blocking)",
                        category: "resource-exhaustion",
                        title: "Expiration query is unbounded.",
                        discussion: "The query has no Limit and no KeysOnly.",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.model_authored_prose).toBe(
            "Expiration query is unbounded. The query has no Limit and no KeysOnly.",
        );
        expect(candidates[0].finding.failure_scenario).toBe(
            "Expiration query is unbounded.",
        );
    });

    it("salvages a label-valid finding with only {id, anchor, discussion} (run 29906543140)", () => {
        // Round-2 correctness drift: valid label, anchor object, rich
        // discussion, but no subject/summary and no failure_scenario.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "ttl-months-vs-days",
                        label: "issue (blocking)",
                        anchor: {path: "a.go", line: 38},
                        discussion:
                            "AddDate(0, -MemoryTTLDays, 0) passes 180 into the months parameter, so the cutoff is 15 years in the past.",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(candidates[0].finding.anchor).toMatchObject({
            path: "a.go",
            line: 38,
        });
        expect(candidates[0].finding.failure_scenario).toContain("AddDate");
    });

    it("salvages suggested_patch as the one-click fix (run 29943085279's drift shape)", () => {
        // That run's correctness pass emitted the ReportFindings-style keys
        // (id, label, severity, category, anchor, summary, discussion,
        // failure_scenario, suggested_patch); the label was valid so the
        // finding salvaged, but the AddDate fix under suggested_patch was
        // dropped and the posted comment carried no suggestion fence.
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        id: "ttl-months-not-days",
                        label: "issue (blocking)",
                        severity: "blocking",
                        category: "correctness",
                        anchor: {
                            path: "services/ai-guide/memory/expiration.go",
                            line: 38,
                        },
                        summary:
                            "AddDate(0, -MemoryTTLDays, 0) subtracts 180 months (15 years), not 180 days; the retention cutoff is ~2011, so no memory is ever expired and the entire feature is a silent no-op.",
                        discussion:
                            "Go's time.Time.AddDate signature is AddDate(years, months, days), so the day count lands in the months slot.",
                        failure_scenario:
                            "A user has memories written 181+ days ago; ExpireStale computes cutoff = now minus 180 months, finds no memory older than that, deletes nothing.",
                        suggested_patch:
                            "cutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.suggested_patch).toBe(
            "cutoff := ctx.Time().Now().AddDate(0, 0, -MemoryTTLDays)",
        );
    });

    it("prefers suggestion over suggested_patch when a finding carries both", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        path: "a.go",
                        line: 38,
                        label: "issue (blocking)",
                        subject: "s",
                        discussion: "d",
                        failure_scenario: "f",
                        suggestion: "the contract key",
                        suggested_patch: "the drift key",
                    },
                ],
            }),
            new Set(),
        );
        expect(candidates[0].finding.suggested_patch).toBe("the contract key");
    });

    it("rejects a finding whose label is missing or unknown (the run's ReportFindings shape)", () => {
        const reportFindingsShape = JSON.stringify({
            findings: [
                {
                    id: "adddate-months-not-days",
                    severity: "blocking",
                    category: "correctness",
                    verdict: "CONFIRMED",
                    file: "a.ts",
                    anchor: {path: "a.ts", line: 38},
                    line: 38,
                    summary: "AddDate subtracts 180 months, not 180 days.",
                    failure_scenario: "retention never expires anything",
                    discussion: "AddDate's signature is (years, months, days).",
                },
            ],
        });
        expect(() =>
            parseFinderOutput(
                "correctness-reviewer",
                reportFindingsShape,
                new Set(),
            ),
        ).toThrow(
            /findings\[0\] label "" is not a Conventional Comments label/,
        );
        expect(() =>
            parseFinderOutput(
                "correctness-reviewer",
                JSON.stringify({
                    findings: [
                        {
                            path: "a.ts",
                            line: 2,
                            label: "blocker (critical)",
                            subject: "s",
                            discussion: "d",
                            failure_scenario: "f",
                        },
                    ],
                }),
                new Set(),
            ),
        ).toThrow(
            /"blocker \(critical\)" is not a Conventional Comments label/,
        );
    });

    it("joins subject and discussion with a sentence break only when needed", () => {
        expect(joinProse("No terminal punctuation", "Both tests pass.")).toBe(
            "No terminal punctuation. Both tests pass.",
        );
        expect(joinProse("Ends with a period.", "More detail.")).toBe(
            "Ends with a period. More detail.",
        );
        expect(joinProse("Ends inside `code.`", "More detail.")).toBe(
            "Ends inside `code.` More detail.",
        );
        expect(joinProse("Ends with a colon:", "the list.")).toBe(
            "Ends with a colon: the list.",
        );
        expect(joinProse("Only a subject", "")).toBe("Only a subject");
        expect(joinProse("", "Only a discussion.")).toBe("Only a discussion.");
    });

    it("drops a subject that restates the discussion's first sentence (PRA-46 W4-W5 repetition mode)", () => {
        // Verbatim restatement: the discussion opens with the subject.
        expect(
            joinProse(
                "The merger drops flagged turns.",
                "The merger drops flagged turns whenever moderation flags a turn mid-stream.",
            ),
        ).toBe(
            "The merger drops flagged turns whenever moderation flags a turn mid-stream.",
        );
        // Inflected restatement: "dropped" vs "drops" still folds together.
        expect(
            joinProse(
                "Flagged turns are dropped by the merger.",
                "The merger drops flagged turns because the filter runs before the merge, so a flagged turn never reaches the sink.",
            ),
        ).toBe(
            "The merger drops flagged turns because the filter runs before the merge, so a flagged turn never reaches the sink.",
        );
        // Markdown wrapping does not defeat the comparison.
        expect(
            joinProse(
                "`counts.go` recomputes the total.",
                "counts.go recomputes the total on every call.",
            ),
        ).toBe("counts.go recomputes the total on every call.");
    });

    it("never drops against a multi-line 'first sentence' (an unterminated opening line)", () => {
        // A discussion opening with an unterminated line plus a bullet list
        // has no [.!?]-then-space split point, so the split returns the whole
        // block. Dropping the subject would let buildClaims' identical split
        // promote that block into claim.subject, which submission.ts prints
        // inside one-line list items.
        const block =
            "The merger drops flagged turns\n- the filter runs first\n- a flagged turn never reaches the sink.";
        expect(joinProse("The merger drops flagged turns.", block)).toBe(
            `The merger drops flagged turns. ${block}`,
        );
    });

    it("folds a bare form against its inflection (the trailing-e strip is what matches)", () => {
        // "reuses" folds to "reus" via the "es" suffix strip; "reuse"
        // carries no strippable suffix and meets it only via the trailing-e
        // strip. If the trailing-e strip regresses, the subject side stays
        // "reuse", the pair stops folding together, and this drop stops
        // firing.
        expect(
            joinProse(
                "Stale cache reuse.",
                "The run reuses a stale cache because the key never rotates.",
            ),
        ).toBe("The run reuses a stale cache because the key never rotates.");
    });

    it("still drops against a multi-line discussion whose FIRST sentence is one line", () => {
        // The drop side of the newline guard: the guard rejects a
        // multi-line first sentence, not any multi-line discussion. A
        // terminated opening sentence on its own line is a safe drop target;
        // buildClaims recovers exactly that line as claim.subject.
        expect(
            joinProse(
                "The merger drops flagged turns.",
                "The merger drops flagged turns on every stream.\nDetails:\n- the filter runs first",
            ),
        ).toBe(
            "The merger drops flagged turns on every stream.\nDetails:\n- the filter runs first",
        );
    });

    it("keeps a subject made entirely of function words (empty token bag)", () => {
        // The early return: with every subject token stopword-filtered away,
        // containment would be vacuously true, so the guard must refuse to
        // drop rather than treat an empty bag as a restatement.
        expect(joinProse("It is as it was.", "The filter runs first.")).toBe(
            "It is as it was. The filter runs first.",
        );
    });

    it("keeps a subject that carries information the opening sentence lacks", () => {
        // Restating a LATER sentence keeps the subject: dropping it would
        // make buildClaims recover the discussion's opening SETUP sentence
        // as claim.subject, which renderPrLevelFold and the HOLD/over-cap
        // collapsed lists print as the finding's one-line header.
        expect(
            joinProse(
                "A delete leaves the stale entry behind.",
                "The cache is written in save(). A delete leaves the stale entry behind.",
            ),
        ).toBe(
            "A delete leaves the stale entry behind. The cache is written in save(). A delete leaves the stale entry behind.",
        );
        // "never invalidated" is not in the first sentence: kept whole.
        expect(
            joinProse(
                "The cache is never invalidated.",
                "The cache is written in save(). A delete leaves the stale entry behind.",
            ),
        ).toBe(
            "The cache is never invalidated. The cache is written in save(). A delete leaves the stale entry behind.",
        );
        // A subject summarizing ACROSS sentences (no single sentence holds
        // all its tokens) is a genuine lede and survives.
        expect(
            joinProse(
                "save() caches, delete leaves it stale.",
                "The cache is written in save(). A delete leaves the stale entry behind.",
            ),
        ).toBe(
            "save() caches, delete leaves it stale. The cache is written in save(). A delete leaves the stale entry behind.",
        );
    });
});

describe("label-shape lens assignment", () => {
    const docFinding = JSON.stringify({
        findings: [
            {
                path: "src/notes/expiry.ts",
                line: 12,
                label: "suggestion (non-blocking, documentation)",
                subject: "The comment above still says 30 days.",
                discussion:
                    "`// notes expire after 30 days` vs `EXPIRY_DAYS = 90`.",
                failure_scenario: "the next reader trusts a false claim",
            },
        ],
    });

    it("assigns the documentation lens, so the finding renders with the documentation label", () => {
        const {candidates} = parseFinderOutput(
            "documentation",
            docFinding,
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.lens).toBe("documentation");
        // The rendered label is a function of severity + lens, and it is the
        // only channel autofix has for telling a documentation thread apart.
        expect(labelForFinding(candidates[0].finding)).toBe(
            "suggestion (non-blocking, documentation)",
        );
    });

    it("assigns the maintainability lens, so the finding renders with its own label", () => {
        const out = JSON.stringify({
            findings: [
                {
                    path: "src/util/dates.ts",
                    line: 4,
                    label: "suggestion (non-blocking, maintainability)",
                    subject: "`dateToString` duplicates `formatDate`.",
                    discussion:
                        "`formatDate` in src/util/format.ts:12 already does this.",
                    failure_scenario:
                        "the next reader has two names for one behavior and picks one at random",
                },
            ],
        });
        const {candidates} = parseFinderOutput(
            "maintainability",
            out,
            new Set(),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].finding.lens).toBe("maintainability");
        expect(labelForFinding(candidates[0].finding)).toBe(
            "suggestion (non-blocking, maintainability)",
        );
    });

    it("keeps skill-auditor on conventions and everything else on correctness", () => {
        const skill = parseFinderOutput(
            "skill-auditor",
            CORRECTNESS_OUT,
            new Set(),
        );
        expect(skill.candidates[0].finding.lens).toBe("conventions");
        const holistic = parseFinderOutput(
            "holistic",
            CORRECTNESS_OUT,
            new Set(),
        );
        expect(holistic.candidates[0].finding.lens).toBe("correctness");
    });
});

describe("verification mechanics", () => {
    const claim = (overrides: Partial<Claim>): Claim => ({
        id: "c1",
        source: "correctness-reviewer",
        path: "a.ts",
        line: 2,
        label: "issue (blocking)",
        subject: "s",
        discussion: "d",
        failure_scenario: "f",
        confidence: 0.7,
        ...overrides,
    });

    it("parses the validator's claims-array contract, skipping malformed entries", () => {
        // The contract (review.md and the eval producer alike) is
        // {"claims": [{id, verification, ...}]}.
        const parsed = parseValidatorOutput(
            JSON.stringify({
                claims: [
                    {id: "c1", verification: "confirmed", confidence: 0.95},
                    {id: "c2", verification: "nonsense"},
                    "not an object",
                    {verification: "refuted"},
                ],
            }),
        );
        expect(Object.keys(parsed)).toEqual(["c1"]);
        expect(() => parseValidatorOutput(JSON.stringify({c1: {}}))).toThrow(
            /no claims array/,
        );
    });

    it("drops refuted, downgrades plausible to non-blocking, applies corrections", () => {
        const claims = [
            claim({id: "refuted"}),
            claim({id: "plausible"}),
            claim({id: "confirmed"}),
            claim({id: "unmentioned"}),
        ];
        const result = applyVerifications(claims, {
            refuted: {verification: "refuted"},
            plausible: {verification: "plausible", confidence: 0.4},
            confirmed: {
                verification: "confirmed",
                corrected: {line: 3, subject: "fixed subject"},
            },
        });
        expect(result.map((c) => c.id)).toEqual([
            "plausible",
            "confirmed",
            "unmentioned",
        ]);
        const plausible = result[0];
        expect(plausible.label).toBe("suggestion (non-blocking)");
        expect(plausible.confidence).toBe(0.4);
        const confirmed = result[1];
        expect(confirmed.line).toBe(3);
        expect(confirmed.subject).toBe("fixed subject");
        expect(confirmed.label).toBe("issue (blocking)");
        expect(result[2].label).toBe("issue (blocking)");
    });

    it("rejects out-of-vocabulary corrected labels and non-integer corrected lines", () => {
        // The drift `fromLabelShape` guards on the finder side, one step
        // later: a truncated label would fail `isBlockingLabel` and silently
        // drop a confirmed blocking claim out of the verdict.
        const result = applyVerifications([claim({id: "c1"})], {
            c1: {
                verification: "confirmed",
                corrected: {
                    label: "issue",
                    line: "7" as unknown as number,
                    subject: "  ",
                    discussion: "a real correction",
                },
            },
        });
        expect(result).toHaveLength(1);
        // Rejected corrections keep the finder's originals...
        expect(result[0].label).toBe("issue (blocking)");
        expect(result[0].line).toBe(claim({}).line);
        expect(result[0].subject).toBe(claim({}).subject);
        // ...while a well-formed one still applies.
        expect(result[0].discussion).toBe("a real correction");
    });

    it("accepts an in-vocabulary corrected label", () => {
        const result = applyVerifications([claim({id: "c1"})], {
            c1: {
                verification: "confirmed",
                corrected: {label: "suggestion (non-blocking)", line: 12},
            },
        });
        expect(result[0].label).toBe("suggestion (non-blocking)");
        expect(result[0].line).toBe(12);
    });

    it("caps an author-disputed claim at a question unless confirmed", () => {
        const result = applyVerifications(
            [claim({id: "c1", author_dispute: "author says no"})],
            {c1: {verification: "plausible"}},
        );
        expect(result[0].label).toBe("question (non-blocking)");
        const confirmed = applyVerifications(
            [claim({id: "c1", author_dispute: "author says no"})],
            {c1: {verification: "confirmed"}},
        );
        expect(confirmed[0].label).toBe("issue (blocking)");
    });

    it("builds claims with the producer label and prose split", () => {
        const candidates = parseFinderOutput(
            "correctness-reviewer",
            CORRECTNESS_OUT,
            new Set(),
        ).candidates;
        const claims = buildClaims(candidates);
        expect(claims[0]).toMatchObject({
            id: "correctness-reviewer-1",
            source: "correctness-reviewer",
            path: "a.ts",
            line: 2,
            label: "issue (blocking)",
            failure_scenario: "nil deref on empty input",
            confidence: 0.7,
        });
    });

    it("recovers the discussion's opening claim and a discussion-salvaged failure_scenario when the restatement drop fires (PRA-46)", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            JSON.stringify({
                findings: [
                    {
                        path: "a.ts",
                        line: 2,
                        label: "issue (blocking)",
                        // Inflected restatement of the discussion's first
                        // sentence: joinProse drops it.
                        subject: "Flagged turns are dropped by the merger.",
                        discussion:
                            "The merger drops flagged turns. The filter runs before the merge.",
                    },
                ],
            }),
            new Set(),
        );
        const [claimed] = buildClaims(candidates);
        // The HOLD/over-cap collapsed lists and renderPrLevelFold print
        // claim.subject as the finding's one-line header: after the drop it
        // is the discussion's own opening claim, never empty.
        expect(claimed?.subject).toBe("The merger drops flagged turns.");
        // The salvage skips the dropped subject: dedup's comparedText reads
        // the discussion only when failure_scenario prefix-matches
        // claim.subject, and the inflected subject would fail that test and
        // compare the claim on one sentence plus its own restatement.
        expect(claimed?.failure_scenario).toBe(
            "The merger drops flagged turns. The filter runs before the merge.",
        );
    });
});

describe("applyVerifications: corrected-field validation", () => {
    it("rejects out-of-vocabulary corrected labels and non-integer corrected lines", () => {
        // The drift `fromLabelShape` guards on the finder side, one step
        // later: a truncated label would fail `isBlockingLabel` and silently
        // drop a confirmed blocking claim out of the verdict.
        const result = applyVerifications([claim({id: "c1"})], {
            c1: {
                verification: "confirmed",
                corrected: {
                    label: "issue",
                    line: "7" as unknown as number,
                    subject: "  ",
                    discussion: "a real correction",
                },
            },
        });
        expect(result).toHaveLength(1);
        // Rejected corrections keep the finder's originals...
        expect(result[0].label).toBe("issue (blocking)");
        expect(result[0].line).toBe(claim({}).line);
        expect(result[0].subject).toBe(claim({}).subject);
        // ...while a well-formed one still applies.
        expect(result[0].discussion).toBe("a real correction");
    });

    it("accepts an in-vocabulary corrected label", () => {
        const result = applyVerifications([claim({id: "c1"})], {
            c1: {
                verification: "confirmed",
                corrected: {label: "suggestion (non-blocking)", line: 12},
            },
        });
        expect(result[0].label).toBe("suggestion (non-blocking)");
        expect(result[0].line).toBe(12);
    });
});

describe("parseClustererOutput", () => {
    it("keeps well-formed clusters and dedupes the ids inside one", () => {
        expect(
            parseClustererOutput(
                JSON.stringify({
                    clusters: [
                        {
                            evidence:
                                "the `maxSamples` comment says 10, not 25",
                            ids: ["a", "b", "a", "c"],
                        },
                    ],
                }),
            ),
        ).toEqual([
            {
                evidence: "the `maxSamples` comment says 10, not 25",
                ids: ["a", "b", "c"],
            },
        ]);
    });

    it("skips entries that cannot merge anything, rather than voiding the dispatch", () => {
        // A single-id "cluster", a missing evidence string, and a non-array
        // `ids` each merge nothing on their own; dropping them keeps the rest
        // of a mostly-good reply usable (a missed merge costs a duplicate
        // comment, so partial credit is the safe direction here).
        expect(
            parseClustererOutput(
                JSON.stringify({
                    clusters: [
                        {evidence: "`maxSamples` cap", ids: ["only-one"]},
                        {ids: ["a", "b"]},
                        {evidence: "`maxSamples` cap", ids: "a,b"},
                        {evidence: "`maxSamples` cap", ids: ["a", 7, "b"]},
                    ],
                }),
            ),
        ).toEqual([{evidence: "`maxSamples` cap", ids: ["a", "b"]}]);
    });

    it("throws on a drifted shape so the corrective re-dispatch fires", () => {
        // Reading a drifted reply as "no duplicates" is how a paid-for
        // dimension goes missing without a trace.
        expect(() =>
            parseClustererOutput(JSON.stringify({groups: []})),
        ).toThrow(/no clusters array/);
        expect(() => parseClustererOutput("not json")).toThrow();
        expect(parseClustererOutput(JSON.stringify({clusters: []}))).toEqual(
            [],
        );
    });

    it("is the clusterer's structured-final contract check", () => {
        const check = contractValidator("claim-clusterer", "clusterer");
        expect(check({clusters: []})).toBeNull();
        expect(check({groups: []})).toMatch(/no clusters array/);
    });
});

describe("parseJsonObject empty-vs-malformed", () => {
    it("names an empty final as empty, not malformed", () => {
        // An empty final is how a refusal presents (#294). Calling it
        // malformed sent three eval runs after the wrong cause.
        expect(() => parseJsonObject("")).toThrow(
            /no final text \(empty output\)/,
        );
        expect(() => parseJsonObject("   \n ")).toThrow(/empty output/);
    });

    it("still names unparseable prose as malformed", () => {
        expect(() =>
            parseJsonObject("I reviewed it and found nothing."),
        ).toThrow(/no parseable JSON object/);
    });
});

describe("the medium importance tier (PRA-7)", () => {
    const claim = (overrides: Partial<Claim>): Claim => ({
        id: "c1",
        source: "correctness-reviewer",
        path: "a.ts",
        line: 2,
        label: "note (non-blocking)",
        subject: "s",
        discussion: "d",
        failure_scenario: "f",
        confidence: 0.7,
        importance: "medium",
        ...overrides,
    });

    const finderOut = (finding: Record<string, unknown>): string =>
        JSON.stringify({
            findings: [
                {
                    path: "a.ts",
                    line: 2,
                    label: "note (non-blocking)",
                    failure_scenario: "the guard never fires",
                    subject: "s",
                    discussion: "The guard never fires on staged logins.",
                    ...finding,
                },
            ],
        });

    it("maps importance: medium onto severity and through buildClaims", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            finderOut({importance: "medium"}),
            new Set(),
        );
        expect(candidates[0].finding.severity).toBe("medium");
        expect(buildClaims(candidates)[0].importance).toBe("medium");
    });

    it("reads anything but the literal medium as minor, without rejecting the finding", () => {
        for (const value of ["high", "MEDIUM", 3, true, undefined]) {
            const {candidates} = parseFinderOutput(
                "correctness-reviewer",
                finderOut(value === undefined ? {} : {importance: value}),
                new Set(),
            );
            expect(candidates[0].finding.severity).toBe("advisory");
            expect(buildClaims(candidates)[0].importance).toBeUndefined();
        }
    });

    it("ignores importance on a blocking label (blocking always posts)", () => {
        const {candidates} = parseFinderOutput(
            "correctness-reviewer",
            finderOut({label: "issue (blocking)", importance: "medium"}),
            new Set(),
        );
        expect(candidates[0].finding.severity).toBe("blocking");
        expect(buildClaims(candidates)[0].importance).toBeUndefined();
    });

    it("strips medium on a plausible verification (unverified fails the tier's test)", () => {
        const result = applyVerifications([claim({})], {
            c1: {verification: "plausible", confidence: 0.4},
        });
        expect(result[0].importance).toBeUndefined();
    });

    it("strips medium on the author-dispute cap", () => {
        const result = applyVerifications(
            [claim({author_dispute: "the author disagrees"})],
            {},
        );
        expect(result[0].label).toBe("question (non-blocking)");
        expect(result[0].importance).toBeUndefined();
    });

    it("applies corrected.importance both directions on confirmed claims", () => {
        const granted = applyVerifications([claim({importance: undefined})], {
            c1: {
                verification: "confirmed",
                corrected: {importance: "medium"},
            },
        });
        expect(granted[0].importance).toBe("medium");
        const stripped = applyVerifications([claim({})], {
            c1: {verification: "confirmed", corrected: {importance: "minor"}},
        });
        expect(stripped[0].importance).toBeUndefined();
    });

    it("skips a corrected.importance grant onto a blocking label", () => {
        const result = applyVerifications(
            [claim({label: "issue (blocking)", importance: undefined})],
            {
                c1: {
                    verification: "confirmed",
                    corrected: {importance: "medium"},
                },
            },
        );
        expect(result[0].importance).toBeUndefined();
    });

    it("keeps medium on an unmentioned claim (missing-output retains whole claims)", () => {
        const result = applyVerifications([claim({})], {});
        expect(result[0].importance).toBe("medium");
    });

    const DIFF = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,3 +1,4 @@",
        " context line",
        "+added line",
        " more context",
        " tail",
    ].join("\n");

    it("vetoes medium off anything not anchored on an added line", () => {
        const changed = computeChangedLines(DIFF);
        const result = applyMediumVeto(
            [
                claim({id: "on-added", line: 2}),
                claim({id: "on-context", line: 1}),
                claim({id: "off-diff", path: "b.ts", line: 2}),
                claim({id: "pr-level", path: undefined, line: undefined}),
            ],
            changed,
        );
        expect(
            result.map((entry) => [entry.id, entry.importance ?? "minor"]),
        ).toEqual([
            ["on-added", "medium"],
            ["on-context", "minor"],
            ["off-diff", "minor"],
            ["pr-level", "minor"],
        ]);
        // The veto strips the tier, never the claim.
        expect(result).toHaveLength(4);
    });
});

describe("the medium veto's change-anchored line set", () => {
    const DIFF_WITH_REMOVAL = [
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -4,3 +4,2 @@",
        " context above",
        "-the removed guard",
        " context below",
    ].join("\n");

    it("keeps medium on a removal-adjacent anchor (dropped-guard findings)", () => {
        const changed = computeChangedLines(DIFF_WITH_REMOVAL);
        const claims: Claim[] = [
            {
                id: "dropped-guard",
                source: "correctness-reviewer",
                path: "b.ts",
                line: 4,
                label: "note (non-blocking)",
                subject: "s",
                discussion: "d",
                failure_scenario: "f",
                confidence: 0.8,
                importance: "medium",
            },
        ];
        const result = applyMediumVeto(claims, changed);
        expect(result[0].importance).toBe("medium");
    });
});

describe("the summary passthrough (fold visible line)", () => {
    it("prefers a finding's authored summary as the claim subject", () => {
        const claims = buildClaims([
            {
                finding: {
                    schema_version: 2,
                    id: "f-1",
                    lens: "correctness",
                    anchor: {
                        type: "line",
                        path: "a.ts",
                        line: 3,
                        side: "RIGHT",
                    },
                    severity: "advisory",
                    confidence: 0.9,
                    evidence_trace: ["e"],
                    failure_scenario: "f",
                    producing_hunt: "h",
                    model_authored_prose:
                        "First sentence of the prose. Second sentence with the detail.",
                    summary: "The authored one-liner.",
                } as never,
                source: "correctness-reviewer",
            } as never,
        ]);
        expect(claims[0].subject).toBe("The authored one-liner.");
        expect(claims[0].discussion).toBe(
            "First sentence of the prose. Second sentence with the detail.",
        );
    });

    it("passes a label shape's subject through as the finding summary", () => {
        const result = parseFinderOutput(
            "reviewer-1",
            JSON.stringify({
                findings: [
                    {
                        path: "a.ts",
                        line: 3,
                        label: "thought (non-blocking)",
                        subject: "A distinct authored subject.",
                        discussion:
                            "The discussion opens differently and carries the mechanism detail.",
                    },
                ],
            }),
            new Set(),
        );
        expect(result.candidates[0]?.finding.summary).toBe(
            "A distinct authored subject.",
        );
        // The restatement case keeps the mechanical fallback: no summary.
        const restated = parseFinderOutput(
            "reviewer-1",
            JSON.stringify({
                findings: [
                    {
                        path: "a.ts",
                        line: 3,
                        label: "thought (non-blocking)",
                        subject: "The merger drops flagged turns.",
                        discussion:
                            "Flagged turns are dropped by the merger. The retry path never re-adds them.",
                    },
                ],
            }),
            new Set(),
        );
        expect(restated.candidates[0]?.finding.summary).toBeUndefined();
    });
});
