/**
 * The Step 3 dispatch roster: which finding producers a run dispatches, in
 * what order, and which ones the invocation cap sheds. Split out of
 * `dispatch.ts` for the same reason `dispatch-contracts.ts` was, its
 * max-lines budget, and following the same precedent (router, budgets,
 * credit-cap): one concern per module, no behaviour change.
 *
 * The immediate cause of the split is worth recording, because it will
 * recur. `dispatch.ts` sat at exactly 1000 lines after #302 and the shared
 * `@khanacademy/eslint-config` caps a file at 1000, so the single line
 * #299 added to the shed ranking took it to 1001. Both PRs were green
 * against their own bases and the collision only existed in the merge, which
 * no per-PR lint run can see. Extracting a concern restores headroom; raising
 * the cap locally would deviate from the house config.
 *
 * Determinism boundary: pure functions over staged routing JSON. No model
 * call, no filesystem, no prose about the code under review.
 */

/** The always-on finders (pattern-triage and thread-reconciler excluded). */
export const DEFAULT_FINDERS = [
    "correctness-reviewer",
    "skill-auditor",
] as const;

/**
 * The skipped-dimension name the triage pass records (distinct from the
 * `pattern-triage` agent name: note lines read "pattern triage not
 * assessed"). Lives here with DEFAULT_FINDERS so the dispatcher (which
 * writes the name) and the plan CLI's dimension mapping (which reads it,
 * submission.ts) share one definition.
 */
export const TRIAGE_DIMENSION = "pattern triage";

/**
 * The Step 3 dispatch/shed ranking, first-shed first. Fill order under the
 * invocation cap is this list reversed after the defaults and matched
 * lenses. An enabled reviewer this table does not know sheds after
 * `conventions` (generic before targeted).
 */
export const SHED_RANKING = [
    "documentation",
    "conventions",
    "first-principles",
    "holistic",
    "completeness",
    "test-adequacy",
] as const;

export type RosterShed = {name: string; cause: "budget"};

export type Roster = {
    /** Finding producers to dispatch, in dispatch-ranking order. */
    finders: string[];
    /** Planned finding producers shed under the invocation cap. */
    shed: RosterShed[];
    /** Whether pattern-triage runs (full/scoped only). */
    triage: boolean;
    /** Whether the reconciler runs (staged threads exist). */
    reconcile: boolean;
};

/**
 * Compute the dispatch roster per the staged depth plan and routing, capped
 * by `runBudget.maxReviewerInvocations` in the Step 3 dispatch ranking
 * (defaults, then matched lenses, then opt-ins by inverse shed order), every
 * capped-out entry recorded as a planned shed. Pipeline steps (triage,
 * reconciler, validator) never consume a slot.
 */
export const computeRoster = (
    depth: string,
    routing: {
        enabledReviewers?: unknown;
        lensesToSpawn?: unknown;
        runBudget?: {maxReviewerInvocations?: unknown};
    },
    hasThreads: boolean,
): Roster => {
    if (depth === "fast") {
        return {finders: [], shed: [], triage: false, reconcile: hasThreads};
    }
    if (depth === "flip-gated") {
        return {
            finders: ["correctness-reviewer"],
            shed: [],
            triage: false,
            reconcile: hasThreads,
        };
    }
    const strings = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string")
            : [];
    const lenses = strings(routing.lensesToSpawn);
    const enabled = strings(routing.enabledReviewers).filter(
        (name) => !lenses.includes(name),
    );
    const optIns = [...enabled].sort((a, b) => {
        const rank = (name: string): number => {
            const index = (SHED_RANKING as readonly string[]).indexOf(name);
            return index === -1 ? -0.5 : index;
        };
        return rank(b) - rank(a);
    });
    const ranked = [...DEFAULT_FINDERS, ...lenses, ...optIns];

    const capRaw = routing.runBudget?.maxReviewerInvocations;
    const cap =
        typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw >= 0
            ? capRaw
            : ranked.length;
    const finders = ranked.slice(0, Math.max(cap, DEFAULT_FINDERS.length));
    const shed = ranked
        .slice(finders.length)
        .map((name): RosterShed => ({name, cause: "budget"}));
    return {finders, shed, triage: true, reconcile: hasThreads};
};
