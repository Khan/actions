import {describe, it, expect} from "vitest";

import {computeLiveMetrics, matchCase} from "./live-match";
import {finding, liveRun, spec} from "./live-match-fixtures";

/**
 * The matcher's tie-break and leftover classification: which of several
 * posted candidates a spec credits, and how a posted finding that satisfied
 * no spec is bucketed (legitimate unspecced via `mayFlagSpecs`, duplicate of
 * a caught spec, or noise). Split from live-match.test.ts on file size.
 */
describe("matchCase: lens tie-break and leftover buckets", () => {
    it("prefers the spec's own lens when several posted candidates match", async () => {
        // Run 33671015442, incident-race-condition: the correctness
        // reviewer's TTL suggestion two lines away hit the loose
        // "concurrent" alternate and was credited with the spec in posted
        // order, while the concurrency-async finding that actually
        // described the lost update sat in the noise column. Posted order
        // is the tiebreak only when no candidate carries the spec's lens.
        const ttl = finding(
            "f-ttl",
            "kvSet without a TTL means concurrent tenants keep the key forever.",
            "advisory",
        );
        const race = {
            ...finding(
                "f-race",
                "two concurrent calls read the same value and one update is lost.",
            ),
            lens: "concurrency-async",
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "lost-update",
                    mechanism: ["race|concurrent"],
                    lens: "concurrency-async",
                }),
            ],
            findings: [ttl, race],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-race"]);
        // The TTL suggestion also matches the (already caught) spec's
        // location and mechanism, so it is a duplicate rather than noise.
        expect(match.duplicates).toEqual([
            {findingId: "f-ttl", specKey: "lost-update"},
        ]);
        expect(match.unmatchedFindingIds).toEqual([]);

        // A spec naming a lens no posted candidate came from falls back to
        // posted order rather than refusing the match.
        const crossLens = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "lost-update",
                    mechanism: ["race|concurrent"],
                    lens: "data-migrations",
                }),
            ],
            findings: [ttl, race],
        });
        const crossLensMatch = await matchCase(
            crossLens.corpusCase,
            crossLens.result,
        );
        expect(crossLensMatch.caught.map((c) => c.findingId)).toEqual([
            "f-ttl",
        ]);

        // Without a lens on the spec, posted order still decides.
        const unlensed = liveRun({
            mustCatchSpecs: [
                spec({key: "lost-update", mechanism: ["race|concurrent"]}),
            ],
            findings: [ttl, race],
        });
        const unlensedMatch = await matchCase(
            unlensed.corpusCase,
            unlensed.result,
        );
        expect(unlensedMatch.caught.map((c) => c.findingId)).toEqual(["f-ttl"]);
    });

    it("buckets a second copy of a caught defect as a duplicate, still noise", async () => {
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            findings: [
                finding("f-first", "floating point totals round late."),
                {
                    ...finding("f-copy", "float math here rounds late."),
                    lens: "money-payments",
                },
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-first"]);
        expect(match.duplicates).toEqual([
            {findingId: "f-copy", specKey: "float-bug"},
        ]);
        expect(match.unmatchedFindingIds).toEqual([]);
        const metrics = computeLiveMetrics([{corpusCase, result, match}]);
        expect(metrics.noise).toEqual({
            numerator: 1,
            denominator: 2,
            rate: 0.5,
            duplicates: 1,
        });
    });

    it("moves a may-flag match out of the noise numerator and reports it", async () => {
        // The fixture really does have an unvalidated discount rate, and the
        // case is about float rounding. A reviewer that says so is right,
        // and the noise column should not charge it.
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            mayFlagSpecs: [
                spec({
                    key: "rate-unvalidated",
                    mechanism: ["rate.{0,40}(negative|above 1|unvalidated)"],
                }),
            ],
            findings: [
                finding("f-float", "floating point totals round late."),
                finding(
                    "f-rate",
                    "a negative or above-1 rate is applied unvalidated.",
                    "advisory",
                ),
                finding("f-template", "no test covers this.", "advisory"),
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-float"]);
        expect(match.legitimateUnspecced).toEqual([
            {
                specKey: "rate-unvalidated",
                findingId: "f-rate",
                via: "deterministic",
                blocking: false,
            },
        ]);
        expect(match.duplicates).toEqual([]);
        expect(match.unmatchedFindingIds).toEqual(["f-template"]);
        const metrics = computeLiveMetrics([{corpusCase, result, match}]);
        expect(metrics.noise).toEqual({
            numerator: 1,
            denominator: 3,
            rate: 1 / 3,
            duplicates: 0,
        });
        expect(metrics.legitimateUnspecced).toEqual({
            numerator: 1,
            denominator: 3,
            rate: 1 / 3,
        });
    });

    it("never lets a may-flag entry claim the case's own ground truth", async () => {
        // Must-catch claims first, so a may-flag entry loose enough to also
        // describe the seeded defect cannot steal the catch. Among the
        // leftovers, a finding whose failure_scenario fits a may-flag entry
        // is taken at its word about what it is about, before the duplicate
        // check. The cost is visible here: a true second copy whose
        // scenario also fits a sloppy may-flag entry reads as legitimate,
        // so keep the entries tight.
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            mayFlagSpecs: [spec({key: "loose", mechanism: ["round"]})],
            findings: [
                finding("f-float", "floating point totals round late."),
                finding("f-copy", "float math rounds late here too."),
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-float"]);
        expect(match.legitimateUnspecced.map((l) => l.findingId)).toEqual([
            "f-copy",
        ]);
        expect(match.duplicates).toEqual([]);
    });

    it("keeps a legitimate finding that borrows the spec's keywords out of the duplicate bucket", async () => {
        // incident-auth-bypass: the correctness finding about the fast path
        // leaving req.session unset said "if the bypass is kept", hitting
        // the spec's "bypass" alternate. It is a distinct real defect the
        // case does not spec, not a second copy of the header-spoof finding.
        const spoof = {
            ...finding(
                "f-spoof",
                "an attacker sets the header and bypasses authentication.",
            ),
            lens: "security-auth",
        };
        const session = finding(
            "f-session",
            "the fast path calls next() with req.session unset, so if the bypass is kept it should populate a service identity.",
            "advisory",
        );
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "bypass",
                    mechanism: ["bypass", "attacker"],
                    lens: "security-auth",
                }),
            ],
            mayFlagSpecs: [
                spec({
                    key: "session-unset",
                    mechanism: ["req\\.session.{0,40}unset"],
                }),
            ],
            findings: [session, spoof],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-spoof"]);
        expect(match.legitimateUnspecced.map((l) => l.specKey)).toEqual([
            "session-unset",
        ]);
        expect(match.duplicates).toEqual([]);
        expect(match.unmatchedFindingIds).toEqual([]);
    });

    it("accepts one copy of a may-flag defect and routes the second to duplicates", async () => {
        // A may-flag entry is satisfied by at most one candidate, like a
        // must-catch spec. Two posted findings about the same unspecced
        // defect are the same merge-stage miss as two copies of a seeded
        // one, and counting both as legitimate would hide it.
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            mayFlagSpecs: [
                spec({
                    key: "rate-unvalidated",
                    mechanism: ["rate.{0,40}(negative|above 1|unvalidated)"],
                }),
            ],
            findings: [
                finding("f-float", "floating point totals round late."),
                finding(
                    "f-rate",
                    "a negative rate is applied unvalidated.",
                    "advisory",
                ),
                finding(
                    "f-rate-copy",
                    "an above 1 rate is applied unvalidated.",
                    "advisory",
                ),
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.legitimateUnspecced.map((l) => l.findingId)).toEqual([
            "f-rate",
        ]);
        expect(match.duplicates).toEqual([
            {findingId: "f-rate-copy", specKey: "rate-unvalidated"},
        ]);
        expect(match.unmatchedFindingIds).toEqual([]);
        const metrics = computeLiveMetrics([{corpusCase, result, match}]);
        expect(metrics.noise.numerator).toBe(1);
        expect(metrics.noise.duplicates).toBe(1);
        expect(metrics.legitimateUnspecced.numerator).toBe(1);
    });

    it("breaks the lens tie on the code-assigned source, not the finding's own lens", async () => {
        // A specialist agent writes `lens` into its own JSON, so a
        // correctness-reviewer finding claiming lens "concurrency-async"
        // must not win the tie over the finding the concurrency-async
        // agent actually produced.
        const impostor = {
            ...finding(
                "f-impostor",
                "kvSet after kvGet lets concurrent calls race.",
                "advisory",
            ),
            lens: "concurrency-async",
            source: "correctness",
        };
        const genuine = {
            ...finding(
                "f-genuine",
                "two concurrent calls read the same value and one update is lost.",
            ),
            lens: "concurrency-async",
            source: "concurrency-async",
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "lost-update",
                    mechanism: ["race|concurrent"],
                    lens: "concurrency-async",
                }),
            ],
            findings: [impostor, genuine],
        });
        expect(result.postedCandidates.map((c) => c.source)).toEqual([
            "correctness",
            "concurrency-async",
        ]);
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-genuine"]);
    });

    it("lets the finding that is about a may-flag defect claim it over an earlier passing mention", async () => {
        // The rungs are passes over every leftover, not a per-candidate
        // walk: posted first, a finding whose prose mentions req.session
        // would otherwise consume the entry at rung 3 and push the finding
        // whose failure_scenario IS the session defect into duplicates.
        const mention = {
            ...finding(
                "f-mention",
                "the handler returns 500 on a malformed header.",
                "advisory",
            ),
            model_authored_prose:
                "Also note the fast path leaves req.session unset.",
        };
        const about = finding(
            "f-about",
            "the fast path calls next() with req.session unset.",
            "advisory",
        );
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            mayFlagSpecs: [
                spec({
                    key: "session-unset",
                    mechanism: ["req\\.session.{0,40}unset"],
                }),
            ],
            findings: [
                finding("f-float", "floating point totals round late."),
                mention,
                about,
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.legitimateUnspecced.map((l) => l.findingId)).toEqual([
            "f-about",
        ]);
        expect(match.duplicates).toEqual([
            {findingId: "f-mention", specKey: "session-unset"},
        ]);
    });

    it("ranks a candidate whose thesis is a may-flag defect last when claiming a spec", async () => {
        // incident-sql-missing-index's backfill spec has no lens and no
        // window, so a NOT NULL DEFAULT rewrite finding that says "every
        // existing row" and "pending" fits it. Posted first, it used to
        // take the catch and its advisory label with it; the finding about
        // the backfill went to duplicates.
        const rewrite = finding(
            "f-rewrite",
            "the table rewrite under an exclusive lock stamps every existing row pending.",
            "advisory",
        );
        const backfill = finding(
            "f-backfill",
            "every existing row is backfilled pending and floods the queue.",
        );
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "backfill",
                    mechanism: ["existing row.{0,40}pending"],
                }),
            ],
            mayFlagSpecs: [
                spec({key: "rewrite-lock", mechanism: ["rewrite.{0,40}lock"]}),
            ],
            findings: [rewrite, backfill],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught).toEqual([
            {
                specKey: "backfill",
                findingId: "f-backfill",
                via: "deterministic",
                blocking: true,
            },
        ]);
        expect(match.legitimateUnspecced.map((l) => l.findingId)).toEqual([
            "f-rewrite",
        ]);
        expect(match.duplicates).toEqual([]);

        // When it is the only fit, it still claims: a may-flag entry cannot
        // turn a catch into a miss.
        const alone = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "backfill",
                    mechanism: ["existing row.{0,40}pending"],
                }),
            ],
            mayFlagSpecs: [
                spec({key: "rewrite-lock", mechanism: ["rewrite.{0,40}lock"]}),
            ],
            findings: [rewrite],
        });
        const aloneMatch = await matchCase(alone.corpusCase, alone.result);
        expect(aloneMatch.caught.map((c) => c.findingId)).toEqual([
            "f-rewrite",
        ]);
    });

    it("routes a leftover whose prose alone names a may-flag defect to legitimate", async () => {
        // Rung 3: the failure_scenario is about neither the caught spec nor
        // the may-flag defect, so rungs 1 and 2 both decline, and only the
        // prose carries the may-flag mechanism. Without rung 3 this reads
        // as noise.
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [spec({key: "float-bug"})],
            mayFlagSpecs: [
                spec({
                    key: "session-unset",
                    mechanism: ["req\\.session.{0,40}unset"],
                }),
            ],
            findings: [
                finding("f-float", "floating point totals round late."),
                {
                    ...finding(
                        "f-prose",
                        "downstream handlers see a surprising value.",
                        "advisory",
                    ),
                    model_authored_prose:
                        "The fast path leaves req.session unset for every downstream handler.",
                },
            ],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-float"]);
        expect(match.legitimateUnspecced.map((l) => l.findingId)).toEqual([
            "f-prose",
        ]);
        expect(match.duplicates).toEqual([]);
        expect(match.unmatchedFindingIds).toEqual([]);
    });

    it("lets a conventions spec win its tie through the skill-auditor's source", async () => {
        // The default skill-auditor stamps conventions findings with source
        // "skill", so a raw source === lens comparison could never credit
        // it; the tie-break resolves the lens through the producer table.
        const correctness = finding(
            "f-corr",
            "the helper name shadows the imported one.",
            "advisory",
        );
        const skill = {
            ...finding(
                "f-skill",
                "the helper name shadows the imported one, per the naming guide.",
                "advisory",
            ),
            lens: "conventions",
            source: "skill",
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "shadowed-name",
                    mechanism: ["shadows"],
                    lens: "conventions",
                }),
            ],
            findings: [correctness, skill],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-skill"]);
    });

    it("keeps a duplicate that mentions a may-flag defect in passing in the duplicate bucket", async () => {
        // The other direction of the same overlap: the candidate arm's
        // correctness copy of the header-spoof finding closed its prose
        // with "downstream handlers are also left with an undefined
        // session". Its failure_scenario is about the spoof, so it is the
        // second copy of the caught defect, not the session finding.
        const spoofSecurity = {
            ...finding(
                "f-spoof",
                "an attacker sets the header and bypasses authentication.",
            ),
            lens: "security-auth",
        };
        const spoofCorrectness = {
            ...finding(
                "f-copy",
                "an unauthenticated caller spoofs the header and bypasses the session check.",
            ),
            model_authored_prose:
                "Trusting the header bypasses authentication. Downstream handlers relying on req.session are also left unset.",
        };
        const {corpusCase, result} = liveRun({
            mustCatchSpecs: [
                spec({
                    key: "bypass",
                    mechanism: ["bypass", "attacker"],
                    lens: "security-auth",
                }),
            ],
            mayFlagSpecs: [
                spec({
                    key: "session-unset",
                    mechanism: ["req\\.session.{0,40}unset"],
                }),
            ],
            findings: [spoofCorrectness, spoofSecurity],
        });
        const match = await matchCase(corpusCase, result);
        expect(match.caught.map((c) => c.findingId)).toEqual(["f-spoof"]);
        expect(match.duplicates).toEqual([
            {findingId: "f-copy", specKey: "bypass"},
        ]);
        expect(match.legitimateUnspecced).toEqual([]);
    });
});
