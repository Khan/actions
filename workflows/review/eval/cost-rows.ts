/**
 * The report rows that turn recorded tokens into dollars, shared by the
 * single-run report (live-ab-report.ts) and the repeats aggregate
 * (aggregate.ts). Rates come from pricing.ts and tokens from the artifacts, so
 * this module only decides what to print.
 *
 * "Cost (list price)" stays the recorded `usd` (the SDK's own meter), so the
 * list row is comparable with every prior artifact. "Cost (Khan rate)" is the
 * same work priced per agent at the overlay's rates (see
 * {@link khanCost} for what an agent the overlay cannot price reads as). The
 * judge and arbiter are priced from their tokens at both rates (they report no
 * dollars of their own), and the run total is the sum. The list card is
 * checked against the SDK's meter on the sub-agent tokens, since it is the one
 * rate table the eval maintains.
 */

import type {AggregateReport, ArmAggregate} from "./aggregate";
import type {ArmRunReport} from "./live-ab-report";
import {
    ANTHROPIC_LIST_RATES,
    khanCost,
    listDrift,
    priceTokens,
    type AgentCost,
    type ModelTokens,
    type RateCard,
} from "./pricing";

export const money = (usd: number | undefined): string =>
    usd === undefined ? "n/a" : `$${usd.toFixed(2)}`;

/** `$list / $khan` for one token set, n/a when there are no tokens. */
const pair = (usage: ModelTokens[] | undefined, khan: RateCard): string =>
    usage === undefined
        ? "n/a"
        : `${money(priceTokens(usage, ANTHROPIC_LIST_RATES).usd)} / ${money(
              priceTokens(usage, khan).usd,
          )}`;

/**
 * The notes that explain a Khan-rate figure: which models the overlay
 * priced, which read at list for want of an entry, how many dispatches had
 * no token counts (priced from their list dollars by the overlay ratio), and
 * what the list row is.
 */
const khanNotes = (
    priced: ReturnType<typeof khanCost>[],
    costs: readonly AgentCost[],
): string => {
    const atList = [...new Set(priced.flatMap((p) => p.atList))].sort();
    const untracked = priced.reduce((sum, p) => sum + p.untracked, 0);
    const overlaid = [
        ...new Set(
            costs
                .flatMap((c) => c.usage ?? [])
                .map((t) => t.model)
                .filter((m) => !atList.includes(m)),
        ),
    ].sort();
    return (
        "Cost (Khan rate) prices the same tokens at the `models.providers` " +
        "overlay in review.md, which is what production meters" +
        (overlaid.length === 0 ? "" : ` (${overlaid.join(", ")})`) +
        ". " +
        (atList.length === 0
            ? ""
            : `No overlay entry, so read at list: ${atList.join(", ")}. `) +
        (untracked === 0
            ? ""
            : `${untracked} dispatch(es) recorded no token counts and are priced from the SDK's list figure by the overlay ratio (at list where the model has none). `) +
        "Cost (list price) is the SDK's own meter, what a bare API key bills, " +
        "and the eval bills at list because it never crosses the api-proxy."
    );
};

/**
 * The list-rate check as a note, or undefined when the eval's list table and
 * the SDK's meter agree on these agents' tokens (pricing.ts's tolerance).
 */
const driftNote = (
    arm: string,
    costs: readonly AgentCost[],
): string | undefined => {
    const drift = listDrift(costs);
    return drift === undefined
        ? undefined
        : `List-rate check (${arm}): the eval's list table prices these ` +
              `tokens at ${money(drift.computedUsd)} and the SDK metered ` +
              `${money(drift.recordedUsd)} (${drift.ratio.toFixed(2)}x). ` +
              "One of the two has moved, see pricing.ts.";
};

/* -------------------------------------------------------------------------- */
/* Single-run report                                                          */
/* -------------------------------------------------------------------------- */

/** An arm's per-agent costs, or undefined on an artifact predating them. */
export const armCosts = (arm: ArmRunReport): AgentCost[] | undefined => {
    const costs = arm.perCase.flatMap((c) => c.agentCosts ?? []);
    return costs.length === 0 ? undefined : costs;
};

/** An arm's sub-agent spend at Khan's rate, or undefined when unrecorded. */
export const armKhanUsd = (
    arm: ArmRunReport,
    khan: RateCard,
): number | undefined => {
    const costs = armCosts(arm);
    return costs === undefined ? undefined : khanCost(costs, khan).usd;
};

/** The judge's and arbiter's tokens on an arm, or undefined when unrecorded. */
const overheadUsage = (arm: ArmRunReport): ModelTokens[] | undefined =>
    arm.overhead === undefined
        ? undefined
        : [...arm.overhead.judge, ...arm.overhead.arbiter];

/**
 * The cost rows that need a rate card, and the notes under the table that
 * say what each is. Rendered only when the caller supplies Khan's rates (the
 * CLI reads them off review.md), so a renderer with no overlay in hand never
 * prints a row it cannot back.
 */
export const pricedRows = (
    baseline: ArmRunReport,
    candidate: ArmRunReport,
    khan: RateCard,
    row: (label: string, base: string, cand: string) => string,
): {rows: string[]; notes: string[]} => {
    const arms = [baseline, candidate];
    const costs = arms.map(armCosts);
    const priced = costs.map((c) =>
        c === undefined ? undefined : khanCost(c, khan),
    );
    const overhead = arms.map(overheadUsage);
    const rows = [
        row("Cost (Khan rate)", money(priced[0]?.usd), money(priced[1]?.usd)),
    ];
    const notes: string[] = [];
    if (costs.every((c) => c === undefined)) {
        notes.push("Khan rate: n/a, this artifact predates per-agent cost.");
    } else {
        notes.push(
            khanNotes(
                priced.flatMap((p) => (p === undefined ? [] : [p])),
                costs.flatMap((c) => c ?? []),
            ),
        );
        arms.forEach((arm, i) => {
            const c = costs[i];
            const note = c === undefined ? undefined : driftNote(arm.arm, c);
            if (note !== undefined) {
                notes.push(note);
            }
        });
    }
    if (overhead.some((o) => o !== undefined)) {
        const totals = arms.map((arm, i) => {
            const k = priced[i];
            const o = overhead[i];
            if (k === undefined || o === undefined) {
                return "n/a";
            }
            const list = arm.usd + priceTokens(o, ANTHROPIC_LIST_RATES).usd;
            return `${money(list)} / ${money(
                k.usd + priceTokens(o, khan).usd,
            )}`;
        });
        rows.push(
            row(
                "Judge + arbiter (list / Khan rate)",
                pair(overhead[0], khan),
                pair(overhead[1], khan),
            ),
            row(
                "Run total (list / Khan rate)",
                totals[0] ?? "n/a",
                totals[1] ?? "n/a",
            ),
        );
        notes.push(
            "Judge + arbiter is the instrument's own spend (haiku, priced " +
                "from tokens), not in Cost. Run total adds it to Cost.",
        );
    }
    return {rows, notes};
};

/* -------------------------------------------------------------------------- */
/* Repeats aggregate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Total tool calls across an arm's case runs, or undefined when no agent
 * reported a count (the SDK-era harness did not). Read beside cost: the
 * gemini-3.8-flash A/B (runs 33671015442 and 33783322586) showed a 1.5x
 * cost delta that was entirely a 3.8x tool-call delta at 2.8x cheaper per
 * call, and the table could not say so.
 */
export const armToolCalls = (arm: ArmRunReport): number | undefined => {
    const counts = arm.perCase.flatMap((c) =>
        (c.toolCalls ?? []).map((t) => t.count),
    );
    return counts.length === 0
        ? undefined
        : counts.reduce((sum, n) => sum + n, 0);
};

/**
 * The "Tool calls" and "Cost per tool call" rows, or none when neither arm
 * reported a count. Per-call cost reads in both currencies when Khan's
 * rates are in hand: the list figure alone overstates a claude arm's
 * per-call price by 2x next to an un-overlaid model.
 */
export const toolCallRows = (
    baseline: ArmRunReport,
    candidate: ArmRunReport,
    khan: RateCard | undefined,
    row: (label: string, base: string, cand: string, delta?: string) => string,
): string[] => {
    const b = armToolCalls(baseline);
    const c = armToolCalls(candidate);
    if (b === undefined && c === undefined) {
        return [];
    }
    const perCall = (
        usd: number | undefined,
        calls: number | undefined,
    ): string =>
        usd === undefined || calls === undefined || calls === 0
            ? "n/a"
            : `$${(usd / calls).toFixed(4)}`;
    const perCallCell = (
        arm: ArmRunReport,
        calls: number | undefined,
    ): string => {
        const list = perCall(arm.usd, calls);
        return khan === undefined
            ? list
            : `${list} / ${perCall(armKhanUsd(arm, khan), calls)}`;
    };
    return [
        row(
            "Tool calls",
            b === undefined ? "n/a" : String(b),
            c === undefined ? "n/a" : String(c),
            b !== undefined && c !== undefined && b > 0
                ? `${(c / b).toFixed(2)}x`
                : "",
        ),
        row(
            khan === undefined
                ? "Cost per tool call"
                : "Cost per tool call (list / Khan rate)",
            perCallCell(baseline, b),
            perCallCell(candidate, c),
        ),
    ];
};

/**
 * The pooled cost rows that need a rate card (see {@link pricedRows} for the
 * single-run equivalents and what each currency is). A pool where only some
 * samples recorded per-agent cost prices those and says how many.
 */
export const pooledCostLines = (
    report: AggregateReport,
    khan: RateCard,
): string[] => {
    const arms: [ArmAggregate, ArmAggregate] = [
        report.arms.baseline,
        report.arms.candidate,
    ];
    const khanCell = (arm: ArmAggregate): string =>
        arm.pooled.costSamples === 0
            ? "n/a"
            : money(khanCost(arm.pooled.agentCosts, khan).usd);
    const overheadCell = (arm: ArmAggregate): string =>
        arm.pooled.overheadSamples === 0
            ? "n/a"
            : pair(arm.pooled.overhead, khan);
    const lines = [
        `| Cost (Khan rate) | ${khanCell(arms[0])} |  | ${khanCell(
            arms[1],
        )} |  |`,
    ];
    if (arms.some((arm) => arm.pooled.overheadSamples > 0)) {
        const total = (arm: ArmAggregate): string =>
            arm.pooled.costSamples === 0 || arm.pooled.overheadSamples === 0
                ? "n/a"
                : `${money(
                      arm.pooled.usd +
                          priceTokens(arm.pooled.overhead, ANTHROPIC_LIST_RATES)
                              .usd,
                  )} / ${money(
                      khanCost(arm.pooled.agentCosts, khan).usd +
                          priceTokens(arm.pooled.overhead, khan).usd,
                  )}`;
        lines.push(
            `| Judge + arbiter (list / Khan rate) | ${overheadCell(
                arms[0],
            )} |  | ${overheadCell(arms[1])} |  |`,
            `| Run total (list / Khan rate) | ${total(arms[0])} |  | ${total(
                arms[1],
            )} |  |`,
        );
    }
    // The same provenance the single-run table carries: which models the
    // overlay priced, which read at list, how many dispatches had no meter,
    // and whether the list table still agrees with the SDK. A pooled Khan
    // figure without them is indistinguishable from a real overlay price
    // when it is in fact a fallback.
    const notes: string[] = [];
    const priced = arms.filter((arm) => arm.pooled.costSamples > 0);
    if (priced.length === 0) {
        notes.push("Khan rate: n/a, no pooled sample carries per-agent cost.");
    } else {
        notes.push(
            khanNotes(
                priced.map((arm) => khanCost(arm.pooled.agentCosts, khan)),
                priced.flatMap((arm) => arm.pooled.agentCosts),
            ),
        );
        for (const arm of priced) {
            const note = driftNote(arm.arm, arm.pooled.agentCosts);
            if (note !== undefined) {
                notes.push(note);
            }
        }
    }
    const partial = arms.filter(
        (arm) =>
            arm.pooled.costSamples > 0 && arm.pooled.costSamples < arm.samples,
    );
    if (partial.length > 0) {
        notes.push(
            "Khan-rate figures cover only the samples that recorded per-agent " +
                `cost (${partial
                    .map(
                        (arm) =>
                            `${arm.arm}: ${arm.pooled.costSamples}/${arm.samples}`,
                    )
                    .join(", ")}), the list figure covers every sample.`,
        );
    }
    return [...lines, ...notes.flatMap((n) => ["", n])];
};
