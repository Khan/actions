/**
 * The per-spec **severity-stability** metric: of the repeats that caught a
 * given spec, how many labelled it blocking.
 *
 * Split out of `aggregate.ts` (which sits at its `max-lines` ceiling) as the
 * self-contained half of the metric: the vocabulary, the two predicates, and
 * the reader-facing prose. The counters themselves are two lines interleaved
 * in `aggregateArm`'s accumulation loop and stay there.
 *
 * ## Why the metric exists
 *
 * Spec matching scores **detection, not severity**. `live-match.ts` satisfies
 * a `mustCatchSpec` on anchor agreement plus a mechanism-regex hit; the
 * label plays no part unless the spec sets `blockingOnly`, and no
 * `mustCatchSpecs` entry in the corpus does — the only two that set it are
 * `mustNotFlagSpecs` traps, where the field means the opposite thing (don't
 * score a non-blocking mention as a false flag). So a run that finds every
 * seeded defect and labels every one of them `nitpick (non-blocking)` scores
 * 100% must-catch recall.
 *
 * `verdictAgreement` does not close the gap. It is a whole-case check, so any
 * *other* blocking finding on the case compensates for a defect that shipped
 * non-blocking. Khan/webapp#41194 is the worked example: `TopKey`'s
 * zero-floor bug was labelled blocking and held the verdict at
 * REQUEST_CHANGES while a claim-validator-**confirmed** nil-map panic posted
 * as `suggestion (non-blocking)`. Verdict agreement green; one confirmed
 * panic out the door as a suggestion.
 *
 * ## What it does not do
 *
 * It does not say which label was *right*. That is a ground-truth question,
 * and answering it means asserting per-spec expected severity — a separate,
 * deliberately deferred decision. This metric only reports what the reviewer
 * did, and (on an identical-arm pool) whether it did the same thing twice.
 *
 * Report-only throughout: nothing here gates a run.
 */

/** The noise-floor band key, shared by the sampler and its tests. */
export const SEVERITY_BAND_METRIC = "blocking rate (caught specs)";

/** The `Miss classes` cell marking a spec whose label was not stable. */
export const SEVERITY_SPLIT_NOTE = "severity split";

/**
 * The recorded label for one caught spec: `true`/`false` when the report
 * carried one, `undefined` when it did not — **no severity evidence, never
 * "non-blocking"**. Artifacts predating `SpecMatch.blocking` carry none, and
 * reading those as non-blocking would invent evidence and drag every rate
 * toward zero.
 *
 * Takes the map rather than the run, and tolerates it being absent entirely:
 * `workflows/` sits outside the root tsconfig's `include`, so a hand-built
 * `SampleRun` missing the field is a runtime crash rather than a compile
 * error, and absent already has a defined meaning here.
 */
export const caughtBlocking = (
    caughtSpecBlocking: Record<string, boolean> | undefined,
    specKey: string,
): boolean | undefined => caughtSpecBlocking?.[specKey];

/**
 * Whether a blocking rate is a **split vote**: the same defect, found by the
 * same prompt on the same input, labelled blocking on some repeats and not on
 * others.
 *
 * Strictly between 0 and 1 is the whole test. With the prompt and the input
 * held fixed there is no threshold to tune, because a split IS the
 * instability — it is definitionally noise, not a number to compare against a
 * bar. `0/n` and `n/n` are consistent (whether or not the consistent answer is
 * the correct one, which this metric does not ask).
 *
 * Only meaningful on an identical-arm pool. Across genuinely different arms a
 * split is a prompt delta, which is what an A/B is for.
 */
export const isSeveritySplit = (
    numerator: number,
    denominator: number,
): boolean => denominator > 0 && numerator > 0 && numerator < denominator;

/**
 * The prose above the per-case table explaining the `(blocking)` rows. Kept
 * with the metric so the explanation and the numbers cannot drift apart.
 */
export const severityTableNote = (identicalArms: boolean): string[] => [
    "A `(blocking)` row reports, of the repeats that CAUGHT that spec, how " +
        "many labelled it blocking. Catching a spec says nothing about " +
        "severity: a spec is satisfied by anchor plus mechanism, and no " +
        "`mustCatchSpecs` entry constrains the label, so a run can score 100% " +
        "must-catch recall while calling every seeded defect a nitpick. " +
        "Verdict agreement does not cover it either, being per-case: any " +
        "other blocking finding compensates.",
    "",
    ...(identicalArms
        ? [
              "The arms here are identical, so a `(blocking)` rate strictly " +
                  "between 0 and 1 is **unstable by construction** — same " +
                  "prompt, same input, split vote, which is the definition of " +
                  `noise rather than a number to tune against. Marked \`${SEVERITY_SPLIT_NOTE}\`. ` +
                  "No threshold tuning is intended and nothing gates on these " +
                  "rows.",
              "",
          ]
        : []),
];
