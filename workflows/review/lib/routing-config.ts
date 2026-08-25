/**
 * The consumer-owned routing map: vocabulary (risk tiers, lens/tier rules) and
 * the parser for `.github/aw/review/ROUTING`.
 *
 * The router (`router.ts`) deliberately ships NO default path->lens or
 * path->tier rules: a repo's layout and risk map belong to that repo, stored
 * explicitly where its owners can read and change them (like
 * `.github/REVIEWERS`), not baked into shared code. This file is the
 * machine-readable complement to the model-facing `risk-classification.md`
 * prose.
 */

import {KNOWN_LENSES} from "./finding-schema";
import type {Lens} from "./finding-schema";

/**
 * Per-file risk tiers, ordered from least to most risky. The order is load-
 * bearing: budget scaling and "highest touched tier" comparisons use the index
 * as the rank, so the run budget is monotonic in tier by construction.
 */
export const RISK_TIERS = ["trivial", "low", "medium", "high"] as const;

export type RiskTier = typeof RISK_TIERS[number];

/** A path-glob -> specialist-lenses rule (consumer-supplied config). */
export type LensRule = {
    pattern: string;
    lenses: Lens[];
};

/**
 * A path-glob -> risk-tier rule (consumer-supplied config). A rule marked
 * `diffDirectionDependent` cannot be finalised from the path alone (e.g.
 * "loosening" vs. "tightening" a permission check, or shrinking vs. growing a
 * migration): the router defers it to the orchestrator's one small-model call
 * rather than guess.
 */
export type RiskRule = {
    pattern: string;
    tier: RiskTier;
    diffDirectionDependent?: boolean;
};

/** Where a consuming repo keeps its routing map, next to its review config. */
export const ROUTING_CONFIG_PATH = ".github/aw/review/ROUTING";

/**
 * The opt-in whole-change reviewers a repo may `enable` in its ROUTING file.
 * None run by default: each costs credits on every PR, so a repo turns one on
 * only once the eval suite shows it earns its keep. (The default roster —
 * correctness, skill audit, triage, reconciliation, validation — needs no
 * enabling.)
 */
export const ENABLEABLE_REVIEWERS = [
    "holistic",
    "completeness",
    "test-adequacy",
    "first-principles",
    "conventions",
    "documentation",
] as const;

export type EnableableReviewer = typeof ENABLEABLE_REVIEWERS[number];

/**
 * The re-review mode dial: how much of the roster a *repeat* review of the
 * same PR runs. The first full review of a ready-for-review PR always runs
 * the whole roster whatever the mode; the dial governs the pushes after it.
 * Ordered cheapest-last:
 *
 *   - `full`:       every push re-runs the whole roster (today's behavior).
 *   - `scoped`:     every push re-runs the whole roster, but reviewers are
 *                   staged only the hunks that are new since the last
 *                   fully-reviewed fingerprint, and comments stay scoped to
 *                   those hunks. Catches fresh defects in new code at a
 *                   fraction of the input cost.
 *   - `flip-gated`: reconcile-only fast path, plus the correctness pass over
 *                   the new hunks; a REQUEST_CHANGES→APPROVE flip is vetoed
 *                   by any validated blocking finding from that pass.
 *   - `fast`:       reconcile-only: threads are verified and resolved,
 *                   nothing new is reviewed (the divergence tripwire is the
 *                   only fresh-code guard).
 *
 * `full` is the default everywhere: a repo pays for a cheaper mode only by
 * writing a `re-review` line in its ROUTING file.
 */
export const RE_REVIEW_MODES = [
    "full",
    "scoped",
    "flip-gated",
    "fast",
] as const;

export type ReReviewMode = typeof RE_REVIEW_MODES[number];

export const DEFAULT_RE_REVIEW_MODE: ReReviewMode = "full";

/**
 * The modifiers the `re-review` line accepts (at most one per line; a later
 * line replaces an earlier one). Both keep the configured depth's roster
 * and staging and change only the REPEAT review's posting surface; the
 * verdict still counts every claim, so nothing either suppresses can flip
 * an outcome, and both apply exactly when a run executes at a reduced
 * depth, so the first full review of a ready PR, a divergence-tripwire
 * re-arm, and every guard that resolves to full depth still post
 * everything.
 *
 *   - `blocking-only`: only blocking findings post inline; every validated
 *     non-blocking finding collapses into a <details> block in the review
 *     body. The strict dial, kept as the rollback if the medium tier
 *     inflates on a consumer.
 *   - `blocking-medium`: blocking findings AND medium-importance findings
 *     post inline (medium spends the non-blocking inline budget); minor
 *     findings collapse. The recommended dial: under `blocking-only`,
 *     three 2026-08-24 approving re-reviews collapsed verified correctness
 *     findings behind a bare count (Khan/actions#367, #371, #366).
 */
export const RE_REVIEW_MODIFIERS = [
    "blocking-only",
    "blocking-medium",
] as const;

/**
 * How many non-blocking findings may post as inline comments per review (the
 * P1 comment budget). Blocking findings never count against it, and
 * `nitpick (non-blocking)` never posts inline at all. Everything over budget
 * collapses into the review body's <details> block; nothing is dropped, the
 * verdict still counts every claim, and the autofix still reaches collapsed
 * findings through its body-sourced work list
 * (workflows/autofix/lib/collapsed.ts), so the budget shrinks the
 * notification surface, never a feature's scope.
 *
 * 3 is set by fiat (the quiet-the-human-surface lane's Q8 decision): at the
 * measured 2.91 findings/run it binds rarely and acts as a backstop against
 * the wall-of-comments failure mode (webapp#41440: 13 non-blocking inline
 * comments in one review). Consumers tune it with a `non-blocking-budget`
 * line in ROUTING.
 */
export const DEFAULT_NON_BLOCKING_INLINE_BUDGET = 3;

/**
 * How Step 3 runs: the orchestrator invokes the deterministic dispatcher
 * (`lib/dispatch.ts`) once, which runs Step 3's phases as code. `scripted`
 * is the only mode; the constant survives as the type routing.json's
 * `dispatchMode` field carries.
 */
export const DISPATCH_MODES = ["scripted"] as const;

export type DispatchMode = typeof DISPATCH_MODES[number];

export const DEFAULT_DISPATCH_MODE: DispatchMode = "scripted";

/** Parsed `.github/aw/review/ROUTING` config. */
export type RoutingFileConfig = {
    lensRules: LensRule[];
    riskRules: RiskRule[];
    /** Opt-in whole-change reviewers this repo enables (canonical order). */
    enabledReviewers: EnableableReviewer[];
    /** The repo's re-review mode (`re-review` line; default `full`). */
    reReviewMode: ReReviewMode;
    /** `re-review <mode> blocking-only`: repeat reviews post only blocking
     * findings inline (see {@link RE_REVIEW_MODIFIERS}). */
    reReviewBlockingOnly: boolean;
    /** `re-review <mode> blocking-medium`: repeat reviews post blocking and
     * medium-importance findings inline (see {@link RE_REVIEW_MODIFIERS}). */
    reReviewBlockingMedium: boolean;
    /** `non-blocking-budget <n>`: how many non-blocking findings may post
     * inline per review (see {@link DEFAULT_NON_BLOCKING_INLINE_BUDGET}). */
    nonBlockingInlineBudget: number;
    /** The dispatch mode: always `scripted`. */
    dispatchMode: DispatchMode;
    /** Fixed-format parse warnings (unknown lens/tier, no-op rule). */
    warnings: string[];
};

const KNOWN_LENS_SET: ReadonlySet<string> = new Set(KNOWN_LENSES);

/**
 * Parse the consumer-owned routing map. Line grammar, `REVIEWERS`-style —
 * blanks and `#` comments skipped, one rule or directive per line:
 *
 *     <pattern> [lens=<lens>[,<lens>…]] [tier=trivial|low|medium|high] [direction-dependent]
 *     enable <reviewer>[,<reviewer>…]
 *     re-review full|scoped|flip-gated|fast [blocking-only|blocking-medium]
 *     non-blocking-budget <n>
 *
 * `lens=` names specialist lenses to spawn when the pattern is touched (multiple
 * matching rules union their lenses). `tier=` assigns a risk tier; when several
 * rules match a path, the LAST matching rule in file order wins
 * (gitignore/CODEOWNERS-style), so write the broad rule first (a high-tier
 * services directory) and its exceptions after it (the trivial testdata
 * subtree beneath it). `direction-dependent` marks a tier
 * that cannot be finalised from the path alone (tightening vs. loosening; see
 * {@link RiskRule.diffDirectionDependent}) and requires `tier=`.
 * `enable` turns on an opt-in whole-change reviewer
 * ({@link ENABLEABLE_REVIEWERS}) for every review in this repo.
 * `re-review` sets the repo's re-review mode ({@link RE_REVIEW_MODES}); when
 * several lines set it the LAST one wins (with a warning), matching the
 * file's last-rule-wins convention. An optional `blocking-only` modifier
 * ({@link RE_REVIEW_MODIFIERS}) makes repeat reviews post only blocking
 * findings inline; an unknown modifier warns and is ignored (the mode still
 * applies), and `full blocking-only` warns that the modifier never applies
 * at full depth. `non-blocking-budget` sets how many non-blocking findings
 * post inline per review ({@link DEFAULT_NON_BLOCKING_INLINE_BUDGET});
 * a malformed value warns and keeps the previous value, and when several
 * lines set it the last one wins (with a warning). A leftover `dispatch`
 * line from the retired dial warns and is ignored (scripted is the only
 * mode).
 *
 * Malformed fields and unknown lens/reviewer names produce a warning and skip
 * the lens or line rather than aborting the run: routing degrades to fewer
 * reviewers, never to a crashed review. An unknown `re-review` mode degrades
 * to `full`: toward more review, never less.
 */
export const parseRoutingConfig = (content: string): RoutingFileConfig => {
    const lensRules: LensRule[] = [];
    const riskRules: RiskRule[] = [];
    const enabled = new Set<EnableableReviewer>();
    let reReviewMode: ReReviewMode = DEFAULT_RE_REVIEW_MODE;
    let reReviewBlockingOnly = false;
    let reReviewBlockingMedium = false;
    let reReviewLineSeen = false;
    let nonBlockingInlineBudget = DEFAULT_NON_BLOCKING_INLINE_BUDGET;
    let budgetLineSeen = false;
    let dispatchLineSeen = false;
    const warnings: string[] = [];

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const lineNo = index + 1;
        const [pattern, ...fields] = line.split(/\s+/);

        if (pattern === "enable") {
            const names = fields.flatMap((field) => field.split(","));
            if (names.length === 0) {
                warnings.push(
                    `ROUTING line ${lineNo}: enable names no reviewer (line skipped)`,
                );
                continue;
            }
            for (const name of names) {
                if (name === "") {
                    continue;
                }
                if (
                    (ENABLEABLE_REVIEWERS as readonly string[]).includes(name)
                ) {
                    enabled.add(name as EnableableReviewer);
                } else {
                    warnings.push(
                        `ROUTING line ${lineNo}: unknown reviewer "${name}" (skipped)`,
                    );
                }
            }
            continue;
        }

        if (pattern === "re-review") {
            if (fields.length < 1 || fields.length > 2) {
                warnings.push(
                    `ROUTING line ${lineNo}: re-review takes one mode and ` +
                        `optionally blocking-only (line skipped)`,
                );
                continue;
            }
            const mode = fields[0];
            if (!(RE_REVIEW_MODES as readonly string[]).includes(mode)) {
                warnings.push(
                    `ROUTING line ${lineNo}: unknown re-review mode ` +
                        `"${mode}" (kept ${reReviewMode})`,
                );
                continue;
            }
            let blockingOnly = false;
            let blockingMedium = false;
            if (fields.length === 2) {
                if (
                    (RE_REVIEW_MODIFIERS as readonly string[]).includes(
                        fields[1],
                    )
                ) {
                    blockingOnly = fields[1] === "blocking-only";
                    blockingMedium = fields[1] === "blocking-medium";
                    if (mode === "full") {
                        // full never executes at a reduced depth, so the
                        // modifier never applies; the mode still does.
                        warnings.push(
                            `ROUTING line ${lineNo}: ${fields[1]} never ` +
                                `applies at full re-review depth (repeat ` +
                                `reviews post everything)`,
                        );
                    }
                } else {
                    warnings.push(
                        `ROUTING line ${lineNo}: unknown re-review ` +
                            `modifier "${fields[1]}" (ignored)`,
                    );
                }
            }
            if (reReviewLineSeen) {
                warnings.push(
                    `ROUTING line ${lineNo}: duplicate re-review line ` +
                        `(last one wins)`,
                );
            }
            reReviewMode = mode as ReReviewMode;
            reReviewBlockingOnly = blockingOnly;
            reReviewBlockingMedium = blockingMedium;
            reReviewLineSeen = true;
            continue;
        }

        if (pattern === "non-blocking-budget") {
            if (fields.length !== 1) {
                warnings.push(
                    `ROUTING line ${lineNo}: non-blocking-budget takes ` +
                        `exactly one number (line skipped)`,
                );
                continue;
            }
            const value = Number(fields[0]);
            if (!Number.isInteger(value) || value < 0) {
                warnings.push(
                    `ROUTING line ${lineNo}: non-blocking-budget must be a ` +
                        `non-negative integer, got "${fields[0]}" (kept ` +
                        `${nonBlockingInlineBudget})`,
                );
                continue;
            }
            if (budgetLineSeen) {
                warnings.push(
                    `ROUTING line ${lineNo}: duplicate non-blocking-budget ` +
                        `line (last one wins)`,
                );
            }
            nonBlockingInlineBudget = value;
            budgetLineSeen = true;
            continue;
        }

        if (pattern === "dispatch") {
            // The dial is retired: scripted dispatch always runs. A leftover
            // line is tolerated (never a crashed run); any value other than
            // `scripted` earns a visible warning so the consumer deletes the
            // line.
            if (fields.length !== 1 || fields[0] !== "scripted") {
                warnings.push(
                    `ROUTING line ${lineNo}: the dispatch dial is retired ` +
                        `(scripted dispatch always runs): delete this line`,
                );
            } else if (!dispatchLineSeen) {
                warnings.push(
                    `ROUTING line ${lineNo}: the dispatch line is obsolete ` +
                        `(scripted dispatch is the only mode): delete it`,
                );
            }
            dispatchLineSeen = true;
            continue;
        }

        const lenses = new Set<Lens>();
        let tier: RiskTier | undefined;
        let directionDependent = false;
        let skipLine = false;

        for (const field of fields) {
            if (field === "direction-dependent") {
                directionDependent = true;
            } else if (field.startsWith("lens=")) {
                for (const name of field.slice("lens=".length).split(",")) {
                    if (name === "") {
                        continue;
                    }
                    if (KNOWN_LENS_SET.has(name)) {
                        lenses.add(name as Lens);
                    } else {
                        warnings.push(
                            `ROUTING line ${lineNo}: unknown lens "${name}" (skipped)`,
                        );
                    }
                }
            } else if (field.startsWith("tier=")) {
                const value = field.slice("tier=".length);
                if ((RISK_TIERS as readonly string[]).includes(value)) {
                    tier = value as RiskTier;
                } else {
                    warnings.push(
                        `ROUTING line ${lineNo}: unknown tier "${value}" (line skipped)`,
                    );
                    skipLine = true;
                }
            } else {
                warnings.push(
                    `ROUTING line ${lineNo}: unrecognised field "${field}" (line skipped)`,
                );
                skipLine = true;
            }
        }

        if (skipLine) {
            continue;
        }
        if (directionDependent && tier === undefined) {
            warnings.push(
                `ROUTING line ${lineNo}: direction-dependent requires tier= (line skipped)`,
            );
            continue;
        }
        if (lenses.size === 0 && tier === undefined) {
            warnings.push(
                `ROUTING line ${lineNo}: rule has no lens= or tier= (line skipped)`,
            );
            continue;
        }

        if (lenses.size > 0) {
            lensRules.push({pattern, lenses: [...lenses]});
        }
        if (tier !== undefined) {
            const rule: RiskRule = {pattern, tier};
            if (directionDependent) {
                rule.diffDirectionDependent = true;
            }
            riskRules.push(rule);
        }
    }

    return {
        lensRules,
        riskRules,
        enabledReviewers: ENABLEABLE_REVIEWERS.filter((reviewer) =>
            enabled.has(reviewer),
        ),
        reReviewMode,
        reReviewBlockingOnly,
        reReviewBlockingMedium,
        nonBlockingInlineBudget,
        dispatchMode: DEFAULT_DISPATCH_MODE,
        warnings,
    };
};
