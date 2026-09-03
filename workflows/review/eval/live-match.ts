/**
 * Finding-to-spec matching and live metrics (`live-ab-plan.md` Phase 3a).
 *
 * A live model run chooses its own finding ids, so the recorded-corpus
 * metrics (which correlate `expected.mustCatch` ids with posted ids) cannot
 * score it. Live-enabled cases instead carry labeled defect specs
 * (`live.mustCatchSpecs` / `live.mustNotFlagSpecs`: path, line window,
 * mechanism alternates), and this module maps a run's POSTED candidates onto
 * them:
 *
 *  - Deterministic first pass: a candidate matches a spec when its anchor
 *    agrees with the spec's path (and line window, when both carry one) AND
 *    any mechanism alternate matches the finding's `failure_scenario` or
 *    `model_authored_prose`, case-insensitively. When several candidates
 *    match one spec, the one whose `source` produces the spec's `lens` wins
 *    (resolved through `lens-sources.ts`, so a `conventions` spec is won by
 *    the skill-auditor's source `skill`), otherwise the first in posted
 *    order (run 33671015442 credited a nearby TTL
 *    suggestion from the correctness reviewer with the race-condition spec
 *    while the concurrency-async finding that actually described it sat
 *    unmatched, and the same shape recurred on three other cases).
 *  - Judge fallback (injected, hard-capped): when a spec stays unmatched but
 *    posted candidates share its file, an async yes/no arbiter may claim the
 *    match. Fallback matches are recorded as such so a human can audit them.
 *  - Leftover classification: a posted candidate that satisfied no spec is
 *    either a LEGITIMATE UNSPECCED finding (it matches one of the case's
 *    `mayFlagSpecs`: a real defect the fixture carries that is not the
 *    case's ground truth), a DUPLICATE (it matches a must-catch spec another
 *    candidate already claimed, or a second copy of an accepted may-flag
 *    defect: the cross-source merge let two copies through), or noise. Only the last two count against the noise rate;
 *    `matchCase` documents the order the three are tested in.
 *
 * `computeLiveMetrics` then aggregates per-case matches into the live
 * analogues of the recorded suite's numbers: must-catch recall, clean
 * false-flag, noise, and verdict agreement.
 */

import type {CorpusCase, LiveDefectSpec} from "./corpus/loader";
import {sourceProducesLens} from "./lens-sources";
import type {RunCandidate, RunResult} from "./runner";

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** How a spec got matched (deterministic pass or the judge fallback). */
export type MatchVia = "deterministic" | "fallback";

export type SpecMatch = {
    specKey: string;
    /** The posted candidate that satisfied the spec. */
    findingId: string;
    via: MatchVia;
    /**
     * Whether the candidate that satisfied the spec carried a **blocking**
     * label (copied from {@link RunCandidate.blocking}, which `render-comment`
     * computes from the finding's `severity` — it is never model-authored
     * text).
     *
     * Recorded because **matching scores detection, not severity**. A spec is
     * satisfied by anchor agreement plus a mechanism-regex hit; the label plays
     * no part unless the spec sets `blockingOnly`, and no `mustCatchSpecs`
     * entry in the corpus does (the two that set it are `mustNotFlagSpecs`
     * traps, where it means the opposite thing). So a run that finds every
     * seeded defect and labels every one of them `nitpick (non-blocking)`
     * scores 100% must-catch recall today.
     *
     * `verdictAgreement` cannot stand in for this. It is a whole-case check,
     * so any *other* blocking finding compensates for a defect that shipped
     * non-blocking. Khan/webapp#41194 is the worked example: `TopKey`'s
     * zero-floor bug was labelled blocking and held the verdict at
     * REQUEST_CHANGES while a claim-validator-**confirmed** nil-map panic
     * posted as `suggestion (non-blocking)` — verdict agreement green, one
     * confirmed panic out the door as a suggestion.
     *
     * Carrying the flag here makes per-defect severity observable downstream
     * (`aggregate.ts` turns it into a per-spec blocking rate and a noise-floor
     * band). It changes no matching decision: report-only, nothing gates on it.
     */
    blocking: boolean;
};

/** The deterministic gate a produced-but-not-posted candidate died at. */
export type DroppedBucket = "provenance" | "scope" | "validation";

export type MissedSpecDetail = {
    specKey: string;
    /**
     * Set when the run PRODUCED a finding describing the spec's defect but a
     * deterministic gate dropped it before posting. A found-but-dropped miss
     * is a different defect class (anchoring discipline, gate calibration)
     * than a true miss (recall); they route to different fixes, so the
     * report must not collapse them.
     */
    droppedBy?: DroppedBucket;
    /** The dropped candidate that matched, when droppedBy is set. */
    findingId?: string;
};

export type CaseMatchReport = {
    caseId: string;
    /** mustCatchSpecs satisfied by a posted candidate. */
    caught: SpecMatch[];
    /** mustCatchSpecs no posted candidate satisfied. */
    missed: string[];
    /** Every missed spec, classified true-miss vs found-but-dropped. */
    missedDetail: MissedSpecDetail[];
    /** mustNotFlagSpecs a posted candidate satisfied (false flags). */
    falseFlags: SpecMatch[];
    /**
     * Posted candidates that describe a must-catch spec ANOTHER candidate
     * already claimed (same location and mechanism). A second copy of a
     * caught defect is a dedup miss, not an unspecced finding. It still
     * counts toward noise (the PR author reads two comments about one bug)
     * but routes to the merge stage rather than the finders.
     */
    duplicates: {findingId: string; specKey: string}[];
    /**
     * Posted candidates that satisfied a `mayFlagSpecs` entry: legitimate,
     * code-grounded findings the case does not spec as ground truth. Not
     * recall, not noise, reported so the noise column stops charging the
     * reviewer for being right about something the fixture author did not
     * intend to plant.
     */
    legitimateUnspecced: SpecMatch[];
    /**
     * Posted candidate ids that satisfied no spec of any kind and duplicate
     * nothing: the residual noise (template comments, speculation, and
     * whatever the may-flag list has not been taught yet).
     */
    unmatchedFindingIds: string[];
    /** Number of posted candidates (the noise denominator contribution). */
    postedCount: number;
};

/**
 * The injected fallback arbiter: does `candidate` describe the defect `spec`
 * names? Used only for specs the deterministic pass left unmatched, and only
 * against candidates on the spec's file; call count is capped by the caller.
 */
export type MatchFallback = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
) => Promise<boolean>;

export type MatchOptions = {
    fallback?: MatchFallback;
    /** Cap on fallback calls per case (default 10). */
    maxFallbackCalls?: number;
};

const DEFAULT_MAX_FALLBACK_CALLS = 10;

/**
 * Every location a spec accepts: the primary path/window plus any
 * `altLocations` (a defect that spans files has more than one correct anchor
 * site; see the type's doc).
 */
const specLocations = (
    spec: LiveDefectSpec,
): {path: string; lineStart?: number; lineEnd?: number}[] =>
    spec.path === undefined
        ? [] // A prLevel spec names no file location.
        : [
              {
                  path: spec.path,
                  ...(spec.lineStart !== undefined
                      ? {lineStart: spec.lineStart, lineEnd: spec.lineEnd}
                      : {}),
              },
              ...(spec.altLocations ?? []),
          ];

/**
 * Whether a candidate shares a file with any of the spec's locations (for a
 * prLevel spec: whether the candidate is itself PR-level).
 */
const onSpecFile = (candidate: RunCandidate, spec: LiveDefectSpec): boolean =>
    spec.prLevel === true
        ? candidate.anchor.type === "pr"
        : specLocations(spec).some(
              (location) => location.path === candidate.path,
          );

/** Whether a candidate's anchor agrees with any of a spec's locations. */
const anchorAgrees = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
): boolean => {
    const anchor = candidate.anchor;
    if (spec.prLevel === true) {
        // A PR-level spec names the title/description; only a PR-level
        // comment can satisfy it. A line-anchored comment is about a file,
        // whatever its mechanism says.
        return anchor.type === "pr";
    }
    if (anchor.type === "pr") {
        // A PR-level comment names no location; mechanism alone decides.
        return true;
    }
    return specLocations(spec).some((location) => {
        if (anchor.path !== location.path) {
            return false;
        }
        if (anchor.type === "file" || location.lineStart === undefined) {
            return true;
        }
        const start =
            anchor.type === "line" ? anchor.start_line ?? anchor.line : 0;
        const end = anchor.type === "line" ? anchor.line : 0;
        // Overlap between the anchor's line range and the location window.
        return (
            end >= location.lineStart &&
            start <= (location.lineEnd ?? location.lineStart)
        );
    });
};

/**
 * Which of the finding's texts a mechanism alternate is tested against.
 * `all` is the matching rule (scenario plus prose, so paraphrase in either
 * counts). `scenario` is the finding's one-paragraph thesis alone, used when
 * the question is what a leftover finding is ABOUT rather than whether it
 * mentions something (see the leftover classification in {@link matchCase}).
 */
export type MechanismScope = "all" | "scenario";

/** Whether any mechanism alternate matches the finding's own description. */
const mechanismAgrees = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
    scope: MechanismScope = "all",
): boolean => {
    const haystack =
        scope === "scenario"
            ? candidate.finding.failure_scenario
            : `${candidate.finding.failure_scenario}\n${candidate.finding.model_authored_prose}`;
    return spec.mechanism.some((alternate) => {
        try {
            return new RegExp(alternate, "i").test(haystack);
        } catch {
            // A malformed alternate falls back to a literal substring test
            // rather than crashing the eval.
            return haystack.toLowerCase().includes(alternate.toLowerCase());
        }
    });
};

/** The deterministic rule: location AND mechanism (AND severity, if pinned). */
export const matchesSpec = (
    candidate: RunCandidate,
    spec: LiveDefectSpec,
    scope: MechanismScope = "all",
): boolean =>
    (spec.blockingOnly !== true || candidate.blocking) &&
    anchorAgrees(candidate, spec) &&
    mechanismAgrees(candidate, spec, scope);

/**
 * Match one case's POSTED candidates against its live specs. Each posted
 * candidate satisfies at most one spec (first match in spec order), so one
 * comment cannot claim two defects; each spec is satisfied by at most one
 * candidate.
 */
export const matchCase = async (
    corpusCase: CorpusCase,
    result: RunResult,
    options: MatchOptions = {},
): Promise<CaseMatchReport> => {
    const mustCatch = corpusCase.live?.mustCatchSpecs ?? [];
    const mustNotFlag = corpusCase.live?.mustNotFlagSpecs ?? [];
    const mayFlag = corpusCase.live?.mayFlagSpecs ?? [];
    const maxFallbackCalls =
        options.maxFallbackCalls ?? DEFAULT_MAX_FALLBACK_CALLS;

    const posted = result.postedCandidates;
    const claimed = new Set<string>(); // candidate ids already used
    const caught: SpecMatch[] = [];
    const missed: string[] = [];
    const falseFlags: SpecMatch[] = [];
    let fallbackCalls = 0;

    /**
     * The unclaimed posted candidate that deterministically satisfies
     * `spec`, preferring one produced by the spec's own lens when the spec
     * names one. A loose mechanism alternate ("concurrent", "overwrit") is
     * meant to accept paraphrase, and a neighbouring finding from another
     * lens can hit it too. When both are present the lens the case was
     * authored against is the finding the case is about. The comparison is
     * against `source`, the producer the pipeline assigned, not
     * `finding.lens`, which a specialist agent writes into its own JSON,
     * resolved through the producer's own lens table because the default
     * skill-auditor stamps `conventions` findings with source `skill`.
     */
    const deterministicClaimant = (
        spec: LiveDefectSpec,
    ): RunCandidate | undefined => {
        const hits = posted.filter(
            (candidate) =>
                !claimed.has(candidate.id) && matchesSpec(candidate, spec),
        );
        const lens = spec.lens;
        if (lens !== undefined) {
            const sameLens = hits.find((candidate) =>
                sourceProducesLens(candidate.source, lens),
            );
            if (sameLens !== undefined) {
                return sameLens;
            }
        }
        return hits[0];
    };

    const claim = async (
        spec: LiveDefectSpec,
    ): Promise<SpecMatch | undefined> => {
        const claimant = deterministicClaimant(spec);
        if (claimant !== undefined) {
            claimed.add(claimant.id);
            return {
                specKey: spec.key,
                findingId: claimant.id,
                via: "deterministic",
                blocking: claimant.blocking,
            };
        }
        if (options.fallback === undefined) {
            return undefined;
        }
        // Fallback: only candidates sharing a spec file, in posted order.
        for (const candidate of posted) {
            if (claimed.has(candidate.id) || !onSpecFile(candidate, spec)) {
                continue;
            }
            if (fallbackCalls >= maxFallbackCalls) {
                return undefined;
            }
            fallbackCalls += 1;
            if (await options.fallback(candidate, spec)) {
                claimed.add(candidate.id);
                return {
                    specKey: spec.key,
                    findingId: candidate.id,
                    via: "fallback",
                    blocking: candidate.blocking,
                };
            }
        }
        return undefined;
    };

    for (const spec of mustCatch) {
        const match = await claim(spec);
        if (match === undefined) {
            missed.push(spec.key);
        } else {
            caught.push(match);
        }
    }

    // Classify each miss: did the run produce a matching finding that a
    // deterministic gate then dropped? Location is relaxed to the file (a
    // mis-anchored real finding is exactly the provenance-drop case this
    // exists to surface); mechanism still has to agree.
    const droppedBuckets: [DroppedBucket, RunCandidate[]][] = [
        ["provenance", result.droppedByProvenance],
        ["scope", result.droppedByScope],
        ["validation", result.droppedByValidation],
    ];
    const missedDetail = missed.map((specKey): MissedSpecDetail => {
        const spec = mustCatch.find((s) => s.key === specKey);
        if (spec === undefined) {
            return {specKey};
        }
        for (const [bucket, candidates] of droppedBuckets) {
            const hit = candidates.find(
                (candidate) =>
                    onSpecFile(candidate, spec) &&
                    mechanismAgrees(candidate, spec),
            );
            if (hit !== undefined) {
                return {specKey, droppedBy: bucket, findingId: hit.id};
            }
        }
        return {specKey};
    });
    // A false flag is a real posting failure; the deterministic rule alone
    // decides it (the fallback exists to rescue recall, not to indict).
    for (const spec of mustNotFlag) {
        // Same claimant rule as must-catch, so a trap that names a lens
        // reports the finding that lens produced as the false flag.
        const claimant = deterministicClaimant(spec);
        if (claimant !== undefined) {
            claimed.add(claimant.id);
            falseFlags.push({
                specKey: spec.key,
                findingId: claimant.id,
                via: "deterministic",
                blocking: claimant.blocking,
            });
        }
    }

    // Classify what is left. The texts overlap in both directions: must-catch
    // mechanisms are loose on purpose (they accept paraphrase: "bypass",
    // "unauthenticated", "backfill"), so a distinct legitimate finding on the
    // same lines often hits one (run 33671015442: the finding that surfaced
    // the injection comment said "unauthenticated", the NOT NULL DEFAULT
    // rewrite finding said "backfill"), and a true second copy of the caught
    // defect can mention a may-flag defect in passing (the header-spoof
    // finding closed with "downstream handlers are also left with an
    // undefined session"). So the order asks what the finding is ABOUT:
    //   1. its failure_scenario alone fits a may-flag entry: legitimate;
    //   2. it fits a caught spec (scenario plus prose): duplicate;
    //   3. it fits a may-flag entry anywhere in its text: legitimate;
    //   4. otherwise: noise.
    // The rungs run as passes over every leftover, not per candidate, so a
    // finding that is ABOUT a may-flag defect (rung 1) claims the entry
    // before a finding that mentions it in passing (rung 3) can, whatever
    // their posted order. Ground truth is safe either way: must-catch
    // claimed first, above. A may-flag entry, like a must-catch spec, is
    // satisfied by at most one candidate: a second copy of the same
    // unspecced defect is the same merge-stage miss a second copy of a
    // seeded one is, and lands in `duplicates` under the may-flag key.
    const duplicates: CaseMatchReport["duplicates"] = [];
    const legitimateUnspecced: SpecMatch[] = [];
    const caughtSpecs = caught.flatMap((match) => {
        const spec = mustCatch.find((s) => s.key === match.specKey);
        return spec === undefined ? [] : [spec];
    });
    const acceptedMayFlag = new Set<string>();
    /**
     * Route a candidate that fits `hits` (the may-flag entries it matches at
     * the current scope): the first entry nobody has claimed accepts it,
     * otherwise it duplicates the first one somebody has.
     */
    const acceptOrDuplicate = (
        candidate: RunCandidate,
        hits: LiveDefectSpec[],
    ): void => {
        claimed.add(candidate.id);
        const fresh = hits.find((spec) => !acceptedMayFlag.has(spec.key));
        if (fresh !== undefined) {
            acceptedMayFlag.add(fresh.key);
            legitimateUnspecced.push({
                specKey: fresh.key,
                findingId: candidate.id,
                via: "deterministic",
                blocking: candidate.blocking,
            });
            return;
        }
        const [first] = hits;
        if (first !== undefined) {
            duplicates.push({findingId: candidate.id, specKey: first.key});
        }
    };
    const leftovers = (): RunCandidate[] =>
        posted.filter((candidate) => !claimed.has(candidate.id));
    // Rung 1.
    for (const candidate of leftovers()) {
        const about = mayFlag.filter((spec) =>
            matchesSpec(candidate, spec, "scenario"),
        );
        if (about.length > 0) {
            acceptOrDuplicate(candidate, about);
        }
    }
    // Rung 2.
    for (const candidate of leftovers()) {
        const duplicateOf = caughtSpecs.find((spec) =>
            matchesSpec(candidate, spec),
        );
        if (duplicateOf !== undefined) {
            claimed.add(candidate.id);
            duplicates.push({
                findingId: candidate.id,
                specKey: duplicateOf.key,
            });
        }
    }
    // Rung 3.
    for (const candidate of leftovers()) {
        const mentions = mayFlag.filter((spec) => matchesSpec(candidate, spec));
        if (mentions.length > 0) {
            acceptOrDuplicate(candidate, mentions);
        }
    }
    // Rung 4.
    const unmatchedFindingIds = leftovers().map((candidate) => candidate.id);

    return {
        caseId: corpusCase.id,
        caught,
        missed,
        missedDetail,
        falseFlags,
        duplicates,
        legitimateUnspecced,
        unmatchedFindingIds,
        postedCount: posted.length,
    };
};

/* -------------------------------------------------------------------------- */
/* Live metrics                                                               */
/* -------------------------------------------------------------------------- */

/** One arm's aggregated live numbers. */
export type LiveMetricsReport = {
    caseCount: number;
    /** Specs caught / specs labeled, across every case. */
    mustCatchRecall: {numerator: number; denominator: number; rate: number};
    /** Cases whose verdict equals the case's expected verdict. */
    verdictAgreement: {numerator: number; denominator: number; rate: number};
    /** must-not-flag specs matched, plus clean cases that blocked. */
    cleanFalseFlag: {count: number; details: string[]};
    /**
     * Posted candidates that are noise / posted candidates. The numerator is
     * residual unmatched findings plus duplicates of caught specs;
     * `duplicates` breaks out how many of the numerator are the latter.
     */
    noise: {
        numerator: number;
        denominator: number;
        rate: number;
        duplicates: number;
    };
    /**
     * Posted candidates that satisfied a `mayFlagSpecs` entry / posted
     * candidates. Not noise and not recall: the share of the review that
     * was right about something the case does not spec.
     */
    legitimateUnspecced: {numerator: number; denominator: number; rate: number};
};

export type LiveCaseRun = {
    corpusCase: CorpusCase;
    result: RunResult;
    match: CaseMatchReport;
};

const rate = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : numerator / denominator;

/**
 * One case's contribution to the noise numerator: residual unmatched
 * findings plus duplicates. The single definition the pooled metric and the
 * per-case report fields both read.
 */
export const noiseCount = (match: CaseMatchReport): number =>
    match.unmatchedFindingIds.length + match.duplicates.length;

export const computeLiveMetrics = (runs: LiveCaseRun[]): LiveMetricsReport => {
    let caughtCount = 0;
    let specCount = 0;
    let verdictHits = 0;
    let unmatched = 0;
    let duplicates = 0;
    let legitimate = 0;
    let posted = 0;
    const falseFlagDetails: string[] = [];

    for (const {corpusCase, result, match} of runs) {
        caughtCount += match.caught.length;
        specCount += match.caught.length + match.missed.length;
        if (result.verdict.event === corpusCase.expected.verdict) {
            verdictHits += 1;
        }
        unmatched += noiseCount(match) - match.duplicates.length;
        duplicates += match.duplicates.length;
        legitimate += match.legitimateUnspecced.length;
        posted += match.postedCount;
        for (const flag of match.falseFlags) {
            falseFlagDetails.push(`${corpusCase.id}:${flag.specKey}`);
        }
        if (
            corpusCase.category === "clean" &&
            (result.verdict.event !== "APPROVE" ||
                result.postedCandidates.some((c) => c.blocking))
        ) {
            falseFlagDetails.push(`${corpusCase.id}:blocked-clean-case`);
        }
    }

    return {
        caseCount: runs.length,
        mustCatchRecall: {
            numerator: caughtCount,
            denominator: specCount,
            rate: rate(caughtCount, specCount),
        },
        verdictAgreement: {
            numerator: verdictHits,
            denominator: runs.length,
            rate: rate(verdictHits, runs.length),
        },
        cleanFalseFlag: {
            count: falseFlagDetails.length,
            details: falseFlagDetails,
        },
        noise: {
            numerator: unmatched + duplicates,
            denominator: posted,
            rate: rate(unmatched + duplicates, posted),
            duplicates,
        },
        legitimateUnspecced: {
            numerator: legitimate,
            denominator: posted,
            rate: rate(legitimate, posted),
        },
    };
};
