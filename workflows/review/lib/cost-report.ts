/**
 * The per-review cost report: every model call a production review made,
 * broken down per sub-agent, priced at Khan's rate, reconciled against what
 * gh-aw metered, and rendered once for the review body (collapsed), the step
 * summary, and the run artifact.
 *
 * Why this exists: a production run leaves cost in three places that never
 * meet. `dispatch-result.json`'s `perAgent[].usd` is the SDK's own meter at
 * Anthropic LIST price (the SDK prices from its bundled table regardless of
 * the api-proxy). gh-aw's `agent_usage.json` is the whole run at Khan's rate
 * (`ai_credits`, 1 credit = $0.01) with no per-agent split. And the prose
 * judge's spend was in neither until dispatch.ts started recording it. So
 * "what did the correctness reviewer cost on this PR" meant halving a list
 * figure by hand, and the orchestrator's share was unknowable.
 *
 * The report prices tokens, never re-prices dollars (pricing.ts):
 *
 *  - Sub-agents: `perAgent[].usage` (the SDK result's `modelUsage`) at
 *    Khan's rate, grouped by agent across attempts. An entry with no tokens
 *    keeps its recorded list dollars and the report says so.
 *  - Prose judge: `perAgent[].judgeUsage`, attributed to the agent it gated
 *    in the per-agent rows and summed into its own row.
 *  - Orchestrator: the remainder. The api-proxy's `token-usage.jsonl` is the
 *    run's whole spend by model (every request crosses it), so the engine's
 *    tokens are that total minus everything the dispatcher accounted for,
 *    per model. Absent when the proxy log is not readable.
 *  - Reconciliation: the proxy total priced at Khan's rate against gh-aw's
 *    `ai_credits`. gh-aw computes those credits from the same proxy log with
 *    the same overlay, so the two should agree to rounding, and a gap means
 *    the rate card this report priced with is not the one gh-aw used.
 *
 * Nothing here posts or writes. cost-report-cli.ts reads the runner's files
 * and does both, fail-open.
 */

import {
    ANTHROPIC_LIST_RATES,
    EMPTY_USAGE,
    khanCost,
    listDrift,
    mergeUsage,
    pinOf,
    priceTokens,
    type ModelTokens,
    type RateCard,
} from "./pricing";

/**
 * The per-agent entry this report prices: the subset of dispatch.ts's
 * `CostAgentEntry` it reads, declared here so the post-step's import closure
 * stays relative and dependency-free (dispatch.ts pulls in the whole
 * dispatcher). dispatch.ts's type is assignable to it.
 */
export type CostAgentEntry = {
    name: string;
    model: string;
    usd: number;
    turns: number;
    wallMs: number;
    usage?: ModelTokens[];
    toolCalls?: number;
    judgeUsage?: ModelTokens[];
    fellBackTo?: string;
    failed?: string;
};

/** gh-aw's `agent_usage.json`, the fields this report reads. */
export type AgentUsageFile = {
    ai_credits?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    primary_model?: string;
};

export type CostReportInputs = {
    perAgent: readonly CostAgentEntry[];
    /** Khan's rate card (the overlay, or gh-aw's models.json on the runner). */
    khan: RateCard;
    /** The api-proxy's whole-run usage by model, when its log was readable. */
    proxyUsage?: readonly ModelTokens[];
    /** gh-aw's roll-up, when written (it lands before the post-steps run). */
    agentUsage?: AgentUsageFile;
};

/** One row of the table: an agent (all attempts), the judge, or the engine. */
export type CostRow = {
    label: string;
    /** Models the row's tokens ran on, undated pins, sorted. */
    models: string[];
    attempts: number;
    toolCalls?: number;
    turns?: number;
    wallMs?: number;
    usage: ModelTokens[];
    /** Khan's rate, from tokens (recorded list dollars where tokens are missing). */
    khanUsd: number;
    /** List: the SDK's meter for agents, the list card for judge and engine. */
    listUsd: number;
    /** Agent rows only: the judge's spend on this agent, at Khan's rate. */
    judgeKhanUsd?: number;
};

export type CostReport = {
    agents: CostRow[];
    judge?: CostRow;
    engine?: CostRow;
    total: {khanUsd: number; listUsd: number};
    /** gh-aw's own figure and what this report makes of the same tokens. */
    reconciliation?: {
        aiCreditsUsd: number;
        proxyKhanUsd: number;
        ratio: number;
    };
    /** Caveats a reader needs: missing meters, unpriced models, a proxy gap. */
    notes: string[];
};

/** Above this, the reconciliation is reported as a disagreement. */
export const RECONCILIATION_TOLERANCE = 0.01;

const sumUsd = (rows: readonly {khanUsd: number; listUsd: number}[]) => ({
    khanUsd: rows.reduce((sum, r) => sum + r.khanUsd, 0),
    listUsd: rows.reduce((sum, r) => sum + r.listUsd, 0),
});

const modelsOf = (usage: readonly ModelTokens[]): string[] =>
    [...new Set(usage.map((u) => pinOf(u.model)))].sort();

/** Tokens of `total` not accounted for by `spent`, per model, floored at 0. */
const remainder = (
    total: readonly ModelTokens[],
    spent: readonly ModelTokens[],
): {usage: ModelTokens[]; overrun: string[]} => {
    // Merge by pin first: the proxy logs dated ids, and two of them for one
    // pin must add up, not overwrite.
    const byPin = new Map<string, ModelTokens>();
    for (const t of mergeUsage(
        total.map((u) => ({...u, model: pinOf(u.model)})),
    )) {
        byPin.set(t.model, t);
    }
    const overrun: string[] = [];
    for (const s of mergeUsage(spent)) {
        const pin = pinOf(s.model);
        const t = byPin.get(pin);
        if (t === undefined) {
            // The dispatcher billed a model the proxy never saw: the log is
            // partial, or the model ran outside the sandbox. Flag, do not
            // invent a negative engine row.
            overrun.push(pin);
            continue;
        }
        const left = {
            model: pin,
            input: t.input - s.input,
            output: t.output - s.output,
            cacheRead: t.cacheRead - s.cacheRead,
            cacheWrite: t.cacheWrite - s.cacheWrite,
        };
        if (
            left.input < 0 ||
            left.output < 0 ||
            left.cacheRead < 0 ||
            left.cacheWrite < 0
        ) {
            overrun.push(pin);
        }
        byPin.set(pin, {
            model: pin,
            input: Math.max(0, left.input),
            output: Math.max(0, left.output),
            cacheRead: Math.max(0, left.cacheRead),
            cacheWrite: Math.max(0, left.cacheWrite),
        });
    }
    const usage = [...byPin.values()].filter(
        (u) => u.input + u.output + u.cacheRead + u.cacheWrite > 0,
    );
    return {usage, overrun: [...new Set(overrun)].sort()};
};

export const buildCostReport = (inputs: CostReportInputs): CostReport => {
    const {khan} = inputs;
    const notes: string[] = [];

    // Agents: group attempts by name. `khanCost` handles the fallbacks (a
    // model the card cannot price reads at its recorded list dollars) and
    // names them. A dispatch with no token counts is handled here instead:
    // with a proxy log in hand its tokens are already inside the orchestrator
    // remainder (the proxy saw them, the dispatcher just could not attribute
    // them), so pricing its recorded dollars here as well would count it
    // twice. Without a proxy log there is nothing else to carry it, so it
    // is priced from its recorded dollars by the overlay ratio.
    const hasProxy =
        inputs.proxyUsage !== undefined && inputs.proxyUsage.length > 0;
    const isUntracked = (a: CostAgentEntry): boolean =>
        a.usage === undefined || a.usage.length === 0;
    const byName = new Map<string, CostAgentEntry[]>();
    for (const entry of inputs.perAgent) {
        byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
    }
    const atList = new Set<string>();
    let untracked = 0;
    const asCost = (a: CostAgentEntry) => ({
        agent: a.name,
        model: a.fellBackTo ?? a.model,
        usd: a.usd,
        ...(a.usage === undefined ? {} : {usage: a.usage}),
    });
    const agents: CostRow[] = [...byName.entries()]
        .map(([name, attempts]): CostRow => {
            const counted = hasProxy
                ? attempts.filter((a) => !isUntracked(a))
                : attempts;
            untracked += attempts.filter(isUntracked).length;
            const priced = khanCost(counted.map(asCost), khan);
            priced.atList.forEach((m) => atList.add(m));
            const usage = mergeUsage(attempts.flatMap((a) => a.usage ?? []));
            const judgeUsage = attempts.flatMap((a) => a.judgeUsage ?? []);
            const toolCalls = attempts.flatMap((a) =>
                a.toolCalls === undefined ? [] : [a.toolCalls],
            );
            return {
                label: name,
                models: modelsOf(
                    usage.length > 0
                        ? usage
                        : attempts.map((a) => ({
                              ...EMPTY_USAGE,
                              model: a.fellBackTo ?? a.model,
                          })),
                ),
                attempts: attempts.length,
                ...(toolCalls.length === 0
                    ? {}
                    : {toolCalls: toolCalls.reduce((s, n) => s + n, 0)}),
                turns: attempts.reduce((s, a) => s + a.turns, 0),
                wallMs: attempts.reduce((s, a) => s + a.wallMs, 0),
                usage,
                khanUsd: priced.usd,
                listUsd: counted.reduce((s, a) => s + a.usd, 0),
                ...(judgeUsage.length === 0
                    ? {}
                    : {judgeKhanUsd: priceTokens(judgeUsage, khan).usd}),
            };
        })
        .sort(
            (a, b) => b.khanUsd - a.khanUsd || a.label.localeCompare(b.label),
        );
    if (atList.size > 0) {
        notes.push(
            `No Khan-rate entry, so read at list: ${[...atList]
                .sort()
                .join(", ")}.`,
        );
    }
    if (untracked > 0) {
        notes.push(
            hasProxy
                ? `${untracked} dispatch(es) recorded no token counts, so their spend is inside the orchestrator row rather than their own.`
                : `${untracked} dispatch(es) recorded no token counts and are priced from the SDK's list figure by the overlay ratio (at list where the model has none).`,
        );
    }
    // The one real cross-check on the split: the eval's list table against
    // the SDK's own meter, over the agents whose tokens it prices in full.
    const drift = listDrift(inputs.perAgent.map(asCost));
    if (drift !== undefined) {
        notes.push(
            `List-rate check: the list table prices the sub-agents' tokens at ` +
                `$${drift.computedUsd.toFixed(2)} and the SDK metered ` +
                `$${drift.recordedUsd.toFixed(2)} (${drift.ratio.toFixed(
                    2,
                )}x), so one of the two has moved (see pricing.ts).`,
        );
    }

    // The prose judge, from every agent's gate.
    const judgeUsage = mergeUsage(
        inputs.perAgent.flatMap((a) => a.judgeUsage ?? []),
    );
    const judge: CostRow | undefined =
        judgeUsage.length === 0
            ? undefined
            : {
                  label: "prose judge",
                  models: modelsOf(judgeUsage),
                  attempts: inputs.perAgent.filter(
                      (a) => a.judgeUsage !== undefined,
                  ).length,
                  usage: judgeUsage,
                  khanUsd: priceTokens(judgeUsage, khan).usd,
                  listUsd: priceTokens(judgeUsage, ANTHROPIC_LIST_RATES).usd,
              };

    // The orchestrator: whatever crossed the proxy that the dispatcher did
    // not account for.
    let engine: CostRow | undefined;
    if (hasProxy && inputs.proxyUsage !== undefined) {
        const spent = [
            ...inputs.perAgent.flatMap((a) => a.usage ?? []),
            ...judgeUsage,
        ];
        const left = remainder(inputs.proxyUsage, spent);
        if (left.overrun.length > 0) {
            notes.push(
                "The dispatcher's meters exceed the proxy's total on " +
                    `${left.overrun.join(", ")}, so the orchestrator row is ` +
                    "floored at zero there and the proxy log is likely partial.",
            );
        }
        const khanPriced = priceTokens(left.usage, khan);
        engine = {
            label: "orchestrator",
            models: modelsOf(left.usage),
            attempts: 1,
            usage: left.usage,
            khanUsd: khanPriced.usd,
            listUsd: priceTokens(left.usage, ANTHROPIC_LIST_RATES).usd,
        };
        if (khanPriced.unpriced.length > 0) {
            notes.push(
                `The proxy saw models this report cannot price: ${khanPriced.unpriced.join(
                    ", ",
                )}.`,
            );
        }
    } else {
        notes.push(
            "The api-proxy log was not readable, so the orchestrator's share " +
                "is not in this table and the total is the dispatcher's alone.",
        );
    }

    const rows = [
        ...agents,
        ...(judge ? [judge] : []),
        ...(engine ? [engine] : []),
    ];
    const total = sumUsd(rows);

    let reconciliation: CostReport["reconciliation"];
    const credits = inputs.agentUsage?.ai_credits;
    if (
        typeof credits === "number" &&
        Number.isFinite(credits) &&
        credits > 0 &&
        inputs.proxyUsage !== undefined
    ) {
        const proxyKhanUsd = priceTokens(inputs.proxyUsage, khan).usd;
        const aiCreditsUsd = credits / 100;
        reconciliation = {
            aiCreditsUsd,
            proxyKhanUsd,
            ratio: proxyKhanUsd / aiCreditsUsd,
        };
        if (Math.abs(reconciliation.ratio - 1) > RECONCILIATION_TOLERANCE) {
            notes.push(
                `gh-aw metered $${aiCreditsUsd.toFixed(2)} and this report ` +
                    `prices the same tokens at $${proxyKhanUsd.toFixed(2)} ` +
                    `(${reconciliation.ratio.toFixed(
                        2,
                    )}x): the rate cards differ.`,
            );
        }
    }

    return {
        agents,
        ...(judge === undefined ? {} : {judge}),
        ...(engine === undefined ? {} : {engine}),
        total,
        ...(reconciliation === undefined ? {} : {reconciliation}),
        notes,
    };
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** `12.3k`, `1.2M`: token counts read as magnitudes, not digits. */
export const compactTokens = (n: number): string =>
    n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : String(n);

const tokensCell = (usage: readonly ModelTokens[]): string => {
    const t = usage.reduce(
        (acc, u) => ({
            input: acc.input + u.input,
            output: acc.output + u.output,
            cacheRead: acc.cacheRead + u.cacheRead,
            cacheWrite: acc.cacheWrite + u.cacheWrite,
        }),
        {...EMPTY_USAGE},
    );
    if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) {
        return "n/a";
    }
    return `${compactTokens(t.input)} / ${compactTokens(
        t.output,
    )} / ${compactTokens(t.cacheRead)} / ${compactTokens(t.cacheWrite)}`;
};

/**
 * Neutralise markup and table pipes in text that is interpolated into the
 * body post-sanitizer. Agent and model names come from review.md and the
 * proxy log, never from model output, but the block lands after gh-aw's
 * ingest step has already sanitised the queue, so nothing here may trust
 * its inputs.
 */
const escapeText = (text: string): string =>
    text.replace(/[<>&|]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A table cell: escaped and capped at 80 characters, so a runaway model id
 * from the proxy log cannot stretch the table past readability (a pin is
 * under 30 characters, a dated id under 40).
 */
const escapeCell = (text: string): string => escapeText(text).slice(0, 80);

/**
 * The markdown table plus its notes. Khan's rate is the headline column,
 * list is beside it, so the reader sees what production paid and what the
 * SDK's own meter claimed.
 */
export const renderCostTable = (report: CostReport): string => {
    const header = [
        "| Agent | Model | Calls | Turns | Wall | Tokens in / out / cache read / cache write | Cost (Khan rate) | List price |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    const row = (r: CostRow, attempts = false): string =>
        `| ${escapeCell(r.label)}${
            attempts && r.attempts > 1 ? ` (${r.attempts} attempts)` : ""
        } | ${escapeCell(r.models.join(", "))} | ${
            r.toolCalls === undefined ? "" : r.toolCalls
        } | ${r.turns === undefined ? "" : r.turns} | ${
            r.wallMs === undefined ? "" : `${Math.round(r.wallMs / 1000)}s`
        } | ${tokensCell(r.usage)} | ${money(r.khanUsd)}${
            r.judgeKhanUsd === undefined
                ? ""
                : ` (+${money(r.judgeKhanUsd)} judge)`
        } | ${money(r.listUsd)} |`;
    const rows = [
        ...report.agents.map((r) => row(r, true)),
        ...(report.judge === undefined ? [] : [row(report.judge)]),
        ...(report.engine === undefined ? [] : [row(report.engine)]),
        `| Total | | | | | | ${money(report.total.khanUsd)} | ${money(
            report.total.listUsd,
        )} |`,
    ];
    const meter =
        report.reconciliation === undefined
            ? []
            : [
                  "",
                  `gh-aw metered ${money(
                      report.reconciliation.aiCreditsUsd,
                  )} for the run (AI credits at the review.md overlay rate). ` +
                      `Cost (Khan rate) prices the same tokens per agent. List price is what a bare API key would have billed.`,
              ];
    return [
        ...header,
        ...rows,
        ...meter,
        ...(report.notes.length === 0
            ? []
            : ["", ...report.notes.map((n) => `- ${escapeText(n)}`)]),
    ].join("\n");
};

/** The summary chip the collapsed block renders under. */
export const COST_SUMMARY = "review cost";

/**
 * The block appended to the review body: collapsed, headline total in the
 * chip, the table inside. The same `<details><summary><sub>` shape the
 * fingerprint stamp uses, which is known to survive gh-aw's sanitizer. A
 * blank line after the summary is what lets the markdown table render.
 */
export const renderCostDetails = (report: CostReport): string =>
    [
        `<details><summary><sub>${COST_SUMMARY}: ${money(
            report.total.khanUsd,
        )} at Khan's rate${
            report.engine === undefined ? " (sub-agents only)" : ""
        }</sub></summary>`,
        "",
        renderCostTable(report),
        "",
        "</details>",
    ].join("\n");

/**
 * Insert the cost block into a review body, before the fingerprint stamp
 * when the body carries one (the stamp is documented as the final block and
 * its reader is last-wins), else appended. Idempotent: a body that already
 * carries a cost block gets it replaced, so a re-run of the step cannot
 * stack two.
 */
export const withCostDetails = (body: string, details: string): string => {
    const start = body.indexOf(`<details><summary><sub>${COST_SUMMARY}`);
    let base = body;
    if (start !== -1) {
        const end = body.indexOf("</details>", start);
        base =
            end === -1
                ? body.slice(0, start)
                : body.slice(0, start) + body.slice(end + "</details>".length);
        base = base.replace(/\n{3,}/g, "\n\n");
    }
    const stamp = base.indexOf("<details><summary><sub>review fingerprint");
    if (stamp === -1) {
        return `${base.replace(/\s+$/, "")}\n\n${details}\n`;
    }
    return `${base
        .slice(0, stamp)
        .replace(/\s+$/, "")}\n\n${details}\n\n${base.slice(stamp)}`;
};
