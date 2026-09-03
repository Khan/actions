/**
 * The one place the eval turns tokens into dollars.
 *
 * Every `usd` the eval records is provider LIST price: the SDK harness's
 * `total_cost_usd` is what Anthropic bills a bare API key. Production meters
 * the same tokens at Khan's rate, set by the `models.providers` overlay in
 * review.md's frontmatter (#314), and that overlay applies inside the awf
 * api-proxy, which the eval never crosses (bare runner VM, real key). So a
 * claude arm's cost row read at 2x what production would bill, and a
 * cross-provider comparison at list skewed against any model with no overlay
 * entry (run 33671015442 read gemini-3.8-flash at 1.5x claude by list and
 * about 3x at Khan's rate).
 *
 * Dollars cannot be re-priced exactly, so the runners record TOKENS per model
 * (the SDK result's `modelUsage` for every sub-agent and the prose judge, in
 * production and in the eval alike, and the Messages API's `usage` for the
 * eval's judge and arbiter) and every dollar a report prints is computed here
 * from those tokens against one of two rate cards:
 *
 *  - Khan's rate: read off review.md's overlay (or, on the runner, gh-aw's
 *    `/tmp/gh-aw/models.json`, which is that overlay merged over the bundled
 *    catalog), the same numbers production bills with. Nothing else in the
 *    repo restates them.
 *  - List: {@link ANTHROPIC_LIST_RATES}, the published Anthropic rates. The
 *    SDK does not expose its own table, so this is the one copy the repo
 *    keeps. The report checks it against the SDK's metered `usd` on every run
 *    and prints the drift when the two disagree by more than
 *    {@link LIST_DRIFT_TOLERANCE}.
 *
 * The recorded `usd` keeps its meaning (the SDK's meter, list) so every prior
 * artifact stays comparable and `--max-usd` still caps in list dollars.
 */

/** Dollars per token, one entry per token class Anthropic bills. */
export type Rates = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};

/** Rates by model pin (the undated id, see {@link pinOf}). */
export type RateCard = ReadonlyMap<string, Rates>;

/** Token counts for one model across some unit of work. */
export type TokenUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};

export type ModelTokens = TokenUsage & {model: string};

export const EMPTY_USAGE: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};

/** $/M tokens to $/token, with Anthropic's cache multipliers (0.1x, 1.25x). */
const perMillion = (input: number, output: number): Rates => ({
    input: input / 1e6,
    output: output / 1e6,
    cacheRead: (input * 0.1) / 1e6,
    cacheWrite: (input * 1.25) / 1e6,
});

/**
 * Anthropic list prices, $/M tokens at the source for legibility. Every model
 * the overlay prices needs an entry (pricing.test.ts checks), and the report
 * checks these against the SDK's meter on every run.
 */
export const ANTHROPIC_LIST_RATES: RateCard = new Map([
    ["claude-opus-4-8", perMillion(5, 25)],
    ["claude-opus-5", perMillion(5, 25)],
    ["claude-sonnet-5", perMillion(2, 10)],
    ["claude-haiku-4-5", perMillion(1, 5)],
    ["claude-fable-5", perMillion(10, 50)],
    ["claude-sonnet-4-6", perMillion(3, 15)],
]);

/**
 * Recorded-vs-computed list disagreement the report tolerates before it
 * prints a drift note. Rounding in the SDK's own accounting is well under
 * this, a rate change is well over it.
 */
export const LIST_DRIFT_TOLERANCE = 0.01;

/**
 * The pin a model id prices under: the dated release suffix stripped
 * (`claude-haiku-4-5-20251001` -> `claude-haiku-4-5`). The overlay keys by
 * pin, the Messages API reports the dated id.
 */
export const pinOf = (model: string): string => model.replace(/-\d{8}$/, "");

/**
 * The workflow frontmatter: the text between the file's first pair of `---`
 * fences (the same slice model-pricing.test.ts reads).
 */
const frontmatterOf = (reviewMd: string): string =>
    reviewMd.split(/^---$/m)[1] ?? "";

/**
 * Build a rate card from the `providers.<provider>.models.<pin>.cost.*`
 * shape (per-token dollars, values as numbers or numeric strings). The
 * shape review.md's overlay uses, and the shape gh-aw writes to
 * `/tmp/gh-aw/models.json` on the runner (the overlay merged over its
 * bundled catalog, the exact table its `ai_credits` were computed with). An
 * entry missing `input` or `output` is dropped rather than half-priced, and
 * missing cache rates fall back to Anthropic's multipliers on the entry's
 * own input rate.
 */
export const rateCardFromProviders = (providers: unknown): RateCard => {
    const card = new Map<string, Rates>();
    if (typeof providers !== "object" || providers === null) {
        return card;
    }
    for (const provider of Object.values(
        providers as Record<string, unknown>,
    )) {
        const models = (provider as {models?: unknown} | null)?.models;
        if (typeof models !== "object" || models === null) {
            continue;
        }
        for (const [pin, model] of Object.entries(
            models as Record<string, unknown>,
        )) {
            const cost = (model as {cost?: unknown} | null)?.cost;
            if (typeof cost !== "object" || cost === null) {
                continue;
            }
            const rate = (key: string): number | undefined => {
                const value = (cost as Record<string, unknown>)[key];
                const n =
                    typeof value === "string"
                        ? Number(value.replace(/^["']|["']$/g, ""))
                        : typeof value === "number"
                        ? value
                        : NaN;
                return Number.isFinite(n) ? n : undefined;
            };
            const input = rate("input");
            const output = rate("output");
            if (input === undefined || output === undefined) {
                continue;
            }
            card.set(pin, {
                input,
                output,
                cacheRead: rate("cache_read") ?? input * 0.1,
                cacheWrite: rate("cache_write") ?? input * 1.25,
            });
        }
    }
    return card;
};

/**
 * Read `models.providers.<provider>.models.<pin>.cost.*` out of review.md as
 * a rate card in $/token. Walks the frontmatter by indentation (the same
 * YAML-ish line reading agent-extract.ts does for the agent blocks) rather
 * than pulling in a YAML parser: the overlay is a nest of mappings with
 * scalar leaves and comment lines, which is all this needs to understand.
 * Values are quoted scientific notation in the file (`"2.5e-06"`), so the
 * quotes are stripped before the number parse. An entry missing `input` or
 * `output` is dropped rather than half-priced, and missing cache rates fall back
 * to Anthropic's multipliers on the entry's own input rate.
 */
export const readOverlayRates = (reviewMd: string): RateCard => {
    // providers -> provider -> models -> pin -> cost -> leaf
    const providers: Record<string, Record<string, unknown>> = {};
    const path: {indent: number; key: string}[] = [];
    for (const raw of frontmatterOf(reviewMd).split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (line.trim() === "" || line.trim().startsWith("#")) {
            continue;
        }
        const match = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
        if (match === null) {
            // A list item, a wrapped scalar, or a key this walker does not
            // model. None of those appear inside the overlay.
            continue;
        }
        const indent = match[1].length;
        const key = match[2];
        const value = match[3]?.trim();
        while (path.length > 0 && path[path.length - 1].indent >= indent) {
            path.pop();
        }
        path.push({indent, key});
        if (value === undefined || value === "") {
            continue;
        }
        // models / providers / <provider> / models / <pin> / cost / <leaf>
        const keys = path.map((p) => p.key);
        if (
            keys.length === 7 &&
            keys[0] === "models" &&
            keys[1] === "providers" &&
            keys[3] === "models" &&
            keys[5] === "cost"
        ) {
            const provider = (providers[keys[2]] ??= {models: {}});
            const models = provider["models"] as Record<
                string,
                {cost: Record<string, string>}
            >;
            const model = (models[keys[4]] ??= {cost: {}});
            model.cost[keys[6]] = value;
        }
    }
    return rateCardFromProviders(providers);
};

/**
 * Per-request token usage off the firewall api-proxy's `token-usage.jsonl`
 * (one JSON object per line: `model`, `input_tokens`, `output_tokens`,
 * `cache_read_tokens`, `cache_write_tokens`), merged by model. The proxy sees
 * every request the sandboxed agent job makes, so this is the run's whole
 * spend: engine, sub-agents, and the prose judge alike. Malformed lines are
 * skipped, as gh-aw's own parser does.
 */
export const parseProxyTokenUsage = (jsonl: string): ModelTokens[] => {
    const entries: ModelTokens[] = [];
    for (const line of jsonl.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (typeof parsed !== "object" || parsed === null) {
            continue;
        }
        const entry = parsed as Record<string, unknown>;
        const count = (key: string): number => {
            const value = entry[key];
            return typeof value === "number" && Number.isFinite(value)
                ? value
                : 0;
        };
        entries.push({
            model:
                typeof entry["model"] === "string" ? entry["model"] : "unknown",
            input: count("input_tokens"),
            output: count("output_tokens"),
            cacheRead: count("cache_read_tokens"),
            cacheWrite: count("cache_write_tokens"),
        });
    }
    return mergeUsage(entries);
};

/**
 * Token usage off a Claude Agent SDK result message's `modelUsage` (keyed by
 * model, with inputTokens, outputTokens, cacheReadInputTokens,
 * cacheCreationInputTokens, and an optional `canonicalModel` the SDK priced
 * under). Undefined when the message carries none, so a runner reports
 * nothing rather than zeros.
 */
export const usageOfResultMessage = (
    message: Record<string, unknown>,
): ModelTokens[] | undefined => {
    const modelUsage = message["modelUsage"];
    if (typeof modelUsage !== "object" || modelUsage === null) {
        return undefined;
    }
    const entries = Object.entries(modelUsage as Record<string, unknown>);
    if (entries.length === 0) {
        return undefined;
    }
    return entries.map(([key, raw]) => {
        const used = (raw ?? {}) as Record<string, unknown>;
        const count = (field: string): number => {
            const value = used[field];
            return typeof value === "number" && Number.isFinite(value)
                ? value
                : 0;
        };
        return {
            model:
                typeof used["canonicalModel"] === "string"
                    ? used["canonicalModel"]
                    : key,
            input: count("inputTokens"),
            output: count("outputTokens"),
            cacheRead: count("cacheReadInputTokens"),
            cacheWrite: count("cacheCreationInputTokens"),
        };
    });
};

/**
 * Token usage off a Messages API response body (`usage` plus the dated
 * `model` the request resolved to), for the judge and the arbiter, which
 * call the API directly and get no dollar figure back. `fallbackModel` is the
 * pinned id, used when the response omits `model`.
 */
export const usageOfResponse = (
    data: {model?: string; usage?: Record<string, unknown>},
    fallbackModel: string,
): ModelTokens => {
    const count = (key: string): number => {
        const value = data.usage?.[key];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    return {
        model: data.model ?? fallbackModel,
        input: count("input_tokens"),
        output: count("output_tokens"),
        cacheRead: count("cache_read_input_tokens"),
        cacheWrite: count("cache_creation_input_tokens"),
    };
};

/** Sum token usage across entries, one entry per model. */
export const mergeUsage = (entries: readonly ModelTokens[]): ModelTokens[] => {
    const byModel = new Map<string, ModelTokens>();
    for (const entry of entries) {
        const current = byModel.get(entry.model) ?? {
            model: entry.model,
            ...EMPTY_USAGE,
        };
        byModel.set(entry.model, {
            model: entry.model,
            input: current.input + entry.input,
            output: current.output + entry.output,
            cacheRead: current.cacheRead + entry.cacheRead,
            cacheWrite: current.cacheWrite + entry.cacheWrite,
        });
    }
    return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
};

/** Dollars for one model's tokens at one rate, or undefined when unpriced. */
const priceOne = (usage: ModelTokens, card: RateCard): number | undefined => {
    const rates = card.get(pinOf(usage.model));
    return rates === undefined
        ? undefined
        : usage.input * rates.input +
              usage.output * rates.output +
              usage.cacheRead * rates.cacheRead +
              usage.cacheWrite * rates.cacheWrite;
};

/**
 * Price token usage against a rate card. `usd` sums every model the card
 * prices, and `unpriced` names the models it does not (their tokens are left out
 * of `usd`, and the report says so), so a card gap is never a silent zero.
 */
export const priceTokens = (
    usage: readonly ModelTokens[],
    card: RateCard,
): {usd: number; unpriced: string[]} => {
    const unpriced = new Set<string>();
    let usd = 0;
    for (const entry of mergeUsage(usage)) {
        const priced = priceOne(entry, card);
        if (priced === undefined) {
            unpriced.add(entry.model);
        } else {
            usd += priced;
        }
    }
    return {usd, unpriced: [...unpriced].sort()};
};

/**
 * One agent dispatch's recorded spend (list, the SDK's meter), the model it
 * was billed on (the pin, or the refusal fallback when the dispatch fell
 * back), and the tokens per model behind the spend when the runner could see
 * them. The unit the report prices.
 */
export type AgentCost = {
    agent: string;
    model: string;
    usd: number;
    usage?: ModelTokens[];
};

/**
 * The overlay-over-list ratio for a pin, when both cards price it. The
 * overlay is a flat multiple of list per model (pricing.test.ts holds it to
 * that), so this re-prices a dollar figure exactly when no tokens exist.
 */
export const khanRatio = (
    model: string,
    khan: RateCard,
    list: RateCard = ANTHROPIC_LIST_RATES,
): number | undefined => {
    const k = khan.get(pinOf(model));
    const l = list.get(pinOf(model));
    return k === undefined || l === undefined || l.input <= 0
        ? undefined
        : k.input / l.input;
};

/**
 * Per-agent costs at Khan's rate. An agent whose tokens the card prices reads
 * as tokens times the overlay. An agent it cannot price keeps its recorded
 * list dollars, which is exactly what production would meter for a model with
 * no overlay entry, and `atList` names those models. An agent with no token
 * counts at all (the field absent, or an empty list from a result that
 * carried no per-model attribution) is counted in `untracked` and priced
 * from its recorded dollars by the overlay ratio for its pin, which is exact
 * given the flat overlay, or kept at list when the pin has no ratio. So a
 * runner that lost its meter reads as its best estimate, never as free.
 */
export const khanCost = (
    costs: readonly AgentCost[],
    khan: RateCard,
): {usd: number; atList: string[]; untracked: number} => {
    const atList = new Set<string>();
    let untracked = 0;
    let usd = 0;
    for (const cost of costs) {
        if (cost.usage === undefined || cost.usage.length === 0) {
            untracked += 1;
            const ratio = khanRatio(cost.model, khan);
            if (ratio === undefined) {
                atList.add(pinOf(cost.model));
                usd += cost.usd;
            } else {
                usd += cost.usd * ratio;
            }
            continue;
        }
        const priced = priceTokens(cost.usage, khan);
        if (priced.unpriced.length > 0) {
            priced.unpriced.forEach((model) => atList.add(model));
            usd += cost.usd;
        } else {
            usd += priced.usd;
        }
    }
    return {usd, atList: [...atList].sort(), untracked};
};

/**
 * Whether the recorded list dollars and the list card disagree by more than
 * the tolerance, over the agents whose tokens the card prices in full (the
 * rest have nothing to compare). Undefined when within tolerance or when
 * there is nothing to compare.
 */
export const listDrift = (
    costs: readonly AgentCost[],
): {computedUsd: number; recordedUsd: number; ratio: number} | undefined => {
    let computed = 0;
    let recorded = 0;
    for (const cost of costs) {
        if (cost.usage === undefined) {
            continue;
        }
        const priced = priceTokens(cost.usage, ANTHROPIC_LIST_RATES);
        if (priced.unpriced.length > 0) {
            continue;
        }
        computed += priced.usd;
        recorded += cost.usd;
    }
    if (recorded <= 0) {
        return undefined;
    }
    const ratio = computed / recorded;
    return Math.abs(ratio - 1) > LIST_DRIFT_TOLERANCE
        ? {computedUsd: computed, recordedUsd: recorded, ratio}
        : undefined;
};
