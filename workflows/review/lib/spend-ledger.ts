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
    env?: {[key: string]: string | undefined};
    /** Where the loud rollback notice goes. Defaults to stderr. */
    warn?: (message: string) => void;
};

export type SpendLedger = {
    /**
     * Add one turn's cost and decide whether the agent may continue. Returns
     * "abort" the first time the dispatch budget is crossed, and on every call
     * after; the caller stops the turn loop and the ledger records the shed.
     */
    recordTurn: (agent: string, deltaUsd: number) => "continue" | "abort";
    /**
     * Whether a NEW agent may be dispatched. Distinct from recordTurn because
     * refusing to start is cheaper than aborting mid-flight, and the two are
     * disclosed differently.
     */
    mayDispatch: (agent: string) => boolean;
    /** Aborted when the budget is crossed; wired into in-flight requests. */
    signal: AbortSignal;
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

    const controller = new AbortController();
    const sheds: SpendShed[] = [];
    let spentUsd = 0;
    let overshootUsd = 0;
    let crossed = false;

    /** Cross once: the first crossing aborts, later ones just accumulate. */
    const cross = (agent: string, kind: SpendShed["kind"]): void => {
        const budget = Math.max(0, ceilingUsd - landingReserveUsd);
        overshootUsd = Math.max(overshootUsd, spentUsd - budget);
        sheds.push({agent, atUsd: spentUsd, kind});
        if (crossed) {
            return;
        }
        crossed = true;
        if (enforcement === "in-code") {
            controller.abort(
                new Error(
                    `review spend ceiling reached: $${spentUsd.toFixed(
                        2,
                    )} of ` +
                        `$${ceilingUsd.toFixed(2)} (dispatch budget ` +
                        `$${budget.toFixed(2)}, landing reserve ` +
                        `$${landingReserveUsd.toFixed(2)})`,
                ),
            );
        }
    };

    return {
        recordTurn: (agent, deltaUsd) => {
            spentUsd += Math.max(0, deltaUsd);
            const decision = decideSpend(
                spentUsd,
                ceilingUsd,
                landingReserveUsd,
            );
            if (!decision.crossed) {
                return "continue";
            }
            cross(agent, "aborted");
            // Proxy-only measures without enforcing, so the turn loop continues
            // exactly as it did before this ledger existed.
            return enforcement === "in-code" ? "abort" : "continue";
        },
        mayDispatch: (agent) => {
            const decision = decideSpend(
                spentUsd,
                ceilingUsd,
                landingReserveUsd,
            );
            if (decision.allowed) {
                return true;
            }
            cross(agent, "refused");
            return enforcement !== "in-code";
        },
        signal: controller.signal,
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
