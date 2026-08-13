/**
 * The in-code spend ceiling: one budget ledger for a review run, asserted per
 * turn, enforced by aborting work rather than by hoping.
 *
 * Why this exists at all. Today's only ceiling is gh-aw's api-proxy credit cap
 * (`maxAiCredits: 2500` in the compiled lock), which is denominated in
 * list-price credits, not in the dollars Khan actually pays, and which the
 * migration deletes along with the proxy. This ledger replaces it in the
 * harness, in real dollars, with two properties the proxy cap does not have:
 * it can shed work gracefully instead of failing a run mid-flight, and it can
 * say in its own output which enforcement was in force.
 *
 * What it deliberately does NOT claim. The proxy cap lives in a container image
 * no Khan repo can edit; this ceiling lives in a repo whose PRs this reviewer
 * reviews, so the location property is genuinely weaker. A provider-side
 * workspace limit was considered as the out-of-repo backstop and dropped as
 * unavailable, so CODEOWNERS on this file plus required review is the whole
 * mitigation. That is a knowing trade, recorded here rather than implied.
 *
 * The shape of enforcement, per the plan's "state the guarantee in force" rule:
 *
 *   - Per TURN, not per wave. Cost arrives one assistant turn at a time, and a
 *     single heavy reviewer can outspend a whole wave of light ones; checking
 *     between waves would notice the overshoot after paying for it.
 *   - Crossing ABORTS in-flight agents through {@link SpendLedger.signal}, and
 *     the abort surfaces as a DISCLOSED shed, never as a silent gap. A review
 *     that quietly drops a dimension because it ran out of money is
 *     indistinguishable from one that found nothing there.
 *   - A landing reserve is held back so the run can still stage, validate, and
 *     post what it already found. A ceiling that leaves nothing to land with
 *     converts an over-budget run into a wasted one.
 *   - `REVIEW_SPEND_ENFORCEMENT=proxy-only` is the loud rollback: the ledger
 *     still measures and still reports, but never aborts. Because this changes
 *     live spend behavior, the escape hatch is explicit and logged rather than
 *     inferred from a missing value.
 */

/** The environment variable that reverts to proxy-only enforcement. */
export const SPEND_ENFORCEMENT_ENV = "REVIEW_SPEND_ENFORCEMENT";

/**
 * The ceiling, in real dollars, for one review run in this repo.
 *
 * Derivation, so the number is auditable rather than folkloric: the compiled
 * lock allows `maxAiCredits: 2500` for the whole agent job, of which the
 * threat-detection pass measurably spends about $0.27 and which this ledger
 * does not govern. $12.50 therefore sits under the agent job's real-terms
 * allowance and far above any measured review (the harness A/B priced a full
 * case's sub-agents around $0.50). It has to sit UNDER the proxy's real-terms
 * equivalent, or a run that crosses this ceiling would have been killed by the
 * proxy first and the shed behaviour would never be observed.
 *
 * Raise it deliberately, with data, and never in the same PR as behaviour
 * changes. Each consumer compiles its own lock, so a consumer with a different
 * credit allowance wants a different number here.
 */
export const CEILING_USD = 12.5;

/**
 * Held back from the ceiling so a shedding run can still finish and post.
 *
 * Sized from what the phases AFTER the reviewer fan-out cost: claim validation
 * is one dispatch (~$0.30 measured, and it is the expensive tail because it
 * reads every claim), plus the reconciler when threads exist. $1.50 covers
 * both with room, and is small enough that reserving it never sheds work that
 * would otherwise have fit.
 */
export const LANDING_RESERVE_USD = 1.5;

/** One dimension shed because the run ran out of money, with the evidence. */
export type SpendShed = {
    /** The agent that was refused or aborted. */
    agent: string;
    /** Total spend at the moment of the decision. */
    atUsd: number;
    /** Refused before dispatch, or aborted mid-flight. */
    kind: "refused" | "aborted";
};

/**
 * The run/cost/outcome record. This is the substrate telemetry schema v0, born
 * inside a migration PR because it costs nothing to shape it here and a second
 * consumer (autofix) will want exactly these fields.
 */
export type SpendReport = {
    schemaVersion: 1;
    /** Which enforcement was actually in force for this run. */
    enforcement: "in-code" | "proxy-only";
    ceilingUsd: number;
    landingReserveUsd: number;
    spentUsd: number;
    /** True once spend passed the dispatch budget (ceiling minus reserve). */
    crossed: boolean;
    /** Peak overshoot past the dispatch budget; 0 when never crossed. */
    overshootUsd: number;
    sheds: SpendShed[];
};

export type SpendDecision = {
    /** Whether more model work may be started or continued. */
    allowed: boolean;
    /** Spend has passed the dispatch budget. */
    crossed: boolean;
    /** Dollars left before the dispatch budget, clamped at 0. */
    remainingUsd: number;
};

/**
 * The whole enforcement rule, as a pure function of three numbers.
 *
 * The dispatch budget is `ceiling - reserve`: work may start while spend is
 * strictly under it. Exported and tested directly because every interesting
 * property of this ledger (does it shed at the right dollar, does it hold the
 * reserve back, does it clamp) is a property of this function.
 */
export const decideSpend = (
    spentUsd: number,
    ceilingUsd: number,
    landingReserveUsd: number,
): SpendDecision => {
    const dispatchBudget = Math.max(0, ceilingUsd - landingReserveUsd);
    const crossed = spentUsd >= dispatchBudget;
    return {
        allowed: !crossed,
        crossed,
        remainingUsd: Math.max(0, dispatchBudget - spentUsd),
    };
};

export type SpendLedgerOptions = {
    ceilingUsd?: number;
    landingReserveUsd?: number;
    /**
     * The process environment, injected so the rollback flag is testable. The
     * flag is read ONCE at construction: an enforcement posture that could
     * change mid-run is not a posture.
     */
    env?: Record<string, string | undefined>;
    /** Where the loud rollback notice goes. Defaults to stderr. */
    warn?: (message: string) => void;
};

export type SpendLedger = {
    /**
     * Record one COMPLETED dispatch's cost. The single writer: the dispatcher
     * calls this once per attempt (a retry and a refusal fallback are separate
     * attempts and each pays), so the total is exact and cannot double count.
     *
     * Deliberately not fed by the runner as well. A ledger with two writers
     * would either double count the same dollars or need per-attempt identity
     * the runner does not have, and the failure mode of getting that wrong is
     * a ceiling that is quietly off by a factor.
     *
     * Crossing here records NO shed for the recording agent: it ran to
     * completion and its findings are kept, so listing it as cut would make
     * the record contradict itself. The agents the crossing actually cuts are
     * disclosed through {@link SpendLedger.recordAborted}.
     */
    recordSpend: (agent: string, usd: number) => void;
    /**
     * Disclose one agent the crossing actually cut: stopped at a turn
     * boundary by the per-turn probe, or killed in flight by the abort
     * signal. Called by the dispatcher, which is the only party that knows
     * which attempt died and why.
     */
    recordAborted: (agent: string) => void;
    /**
     * Enter the landing phase: the reviewer fan-out is over, and from here on
     * the gates compare against the FULL ceiling, so the landing reserve can
     * fund the validation it was held back for. One-way, once per run.
     */
    enterLanding: () => void;
    /**
     * Mid-flight probe: would an agent that has spent `inFlightUsd` so far push
     * the run past its budget? Read-only, so calling it cannot disturb the
     * accounting, and the runner calls it every turn to decide whether to stop.
     *
     * Concurrency is approximated exactly as the investigation cap approximates
     * it: each in-flight agent probes with its own spend and cannot see its
     * siblings', so a wave can overshoot by at most the number of agents
     * running at once. That is acceptable for a ceiling and is measured in the
     * report's `overshootUsd` rather than assumed away.
     */
    wouldCross: (inFlightUsd: number) => boolean;
    /**
     * Whether a NEW agent may be dispatched. Distinct from recordTurn because
     * refusing to start is cheaper than aborting mid-flight, and the two are
     * disclosed differently.
     */
    mayDispatch: (agent: string) => boolean;
    /**
     * Aborted when the CURRENT phase's budget is crossed; wired into
     * in-flight requests. A property getter on purpose: the dispatch-phase
     * signal fires at `ceiling - reserve` and must not kill the landing
     * dispatches the reserve exists to fund, so entering the landing phase
     * swaps in a fresh signal that fires only at the full ceiling. Consumers
     * that need the live value must read it per request, not capture it once.
     */
    readonly signal: AbortSignal;
    spentUsd: () => number;
    report: () => SpendReport;
};

export const createSpendLedger = (
    options: SpendLedgerOptions = {},
): SpendLedger => {
    const ceilingUsd = options.ceilingUsd ?? CEILING_USD;
    const landingReserveUsd = options.landingReserveUsd ?? LANDING_RESERVE_USD;
    const env = options.env ?? process.env;
    const warn =
        options.warn ??
        ((message: string) => {
            // eslint-disable-next-line no-console
            console.error(message);
        });

    const enforcement =
        env[SPEND_ENFORCEMENT_ENV] === "proxy-only" ? "proxy-only" : "in-code";
    if (enforcement === "proxy-only") {
        warn(
            `review dispatch: in-code spend ceiling DISABLED ` +
                `(${SPEND_ENFORCEMENT_ENV}=proxy-only); spend is bounded only by ` +
                `the proxy's list-price credit cap. Measuring, not enforcing.`,
        );
    }

    const dispatchController = new AbortController();
    const landingController = new AbortController();
    const sheds: SpendShed[] = [];
    let spentUsd = 0;
    let overshootUsd = 0;
    let crossed = false;
    let phase: "dispatch" | "landing" = "dispatch";

    /** The reserve the CURRENT phase still holds back (landing spends it). */
    const reserveNow = (): number =>
        phase === "landing" ? 0 : landingReserveUsd;

    /**
     * Note a crossing of the current phase's budget: track overshoot (always
     * against the dispatch budget, the report's denominator), and abort the
     * phase's controller. No shed is recorded here; who was actually cut is
     * the dispatcher's knowledge ({@link SpendLedger.recordAborted}).
     */
    const noteCrossing = (): void => {
        const budget = Math.max(0, ceilingUsd - landingReserveUsd);
        overshootUsd = Math.max(overshootUsd, spentUsd - budget);
        crossed = true;
        if (enforcement !== "in-code") {
            return;
        }
        const controller =
            phase === "landing" ? landingController : dispatchController;
        if (!controller.signal.aborted) {
            controller.abort(
                new Error(
                    `review spend ceiling reached: $${spentUsd.toFixed(
                        2,
                    )} of ` +
                        `$${ceilingUsd.toFixed(2)} (dispatch budget ` +
                        `$${budget.toFixed(2)}, landing reserve ` +
                        `$${landingReserveUsd.toFixed(2)}, phase ${phase})`,
                ),
            );
        }
    };

    return {
        recordSpend: (agent, usd) => {
            void agent; // The completer is not shed; see the type's doc.
            spentUsd += Math.max(0, usd);
            if (decideSpend(spentUsd, ceilingUsd, reserveNow()).crossed) {
                noteCrossing();
            }
        },
        recordAborted: (agent) => {
            sheds.push({agent, atUsd: spentUsd, kind: "aborted"});
        },
        enterLanding: () => {
            phase = "landing";
        },
        wouldCross: (inFlightUsd) => {
            if (enforcement !== "in-code") {
                return false;
            }
            return decideSpend(
                spentUsd + Math.max(0, inFlightUsd),
                ceilingUsd,
                reserveNow(),
            ).crossed;
        },
        mayDispatch: (agent) => {
            const decision = decideSpend(spentUsd, ceilingUsd, reserveNow());
            if (decision.allowed) {
                return true;
            }
            noteCrossing();
            if (enforcement !== "in-code") {
                // Rollback mode: the dispatch proceeds, so recording it as a
                // shed would disclose a cut that never happened. The report
                // still says crossed, which is the honest record.
                return true;
            }
            sheds.push({agent, atUsd: spentUsd, kind: "refused"});
            return false;
        },
        get signal() {
            return (
                phase === "landing" ? landingController : dispatchController
            ).signal;
        },
        spentUsd: () => spentUsd,
        report: () => ({
            schemaVersion: 1,
            enforcement,
            ceilingUsd,
            landingReserveUsd,
            spentUsd,
            crossed,
            overshootUsd: Math.max(0, overshootUsd),
            sheds: [...sheds],
        }),
    };
};
