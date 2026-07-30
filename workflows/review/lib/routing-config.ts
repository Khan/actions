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
 * The dispatch-mode dial (deterministic-orchestrator slice 2): `task` keeps
 * the orchestrator's Task-tool dispatch (today's behavior); `scripted` has
 * the orchestrator invoke the deterministic dispatcher (`lib/dispatch.ts`)
 * once, which runs Step 3's phases as code. Opt-in per repo while the
 * scripted path is live-trial-gated; the default flips with a release once
 * the trial holds.
 */
export const DISPATCH_MODES = ["task", "scripted"] as const;

export type DispatchMode = typeof DISPATCH_MODES[number];

export const DEFAULT_DISPATCH_MODE: DispatchMode = "task";

/** Parsed `.github/aw/review/ROUTING` config. */
export type RoutingFileConfig = {
    lensRules: LensRule[];
    riskRules: RiskRule[];
    /** Opt-in whole-change reviewers this repo enables (canonical order). */
    enabledReviewers: EnableableReviewer[];
    /** The repo's re-review mode (`re-review` line; default `full`). */
    reReviewMode: ReReviewMode;
    /** The repo's dispatch mode (`dispatch` line; default `task`). */
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
 *     re-review full|scoped|flip-gated|fast
 *     dispatch task|scripted
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
 * file's last-rule-wins convention. `dispatch` sets the dispatch mode
 * ({@link DISPATCH_MODES}) with the same last-one-wins rule; an unknown mode
 * degrades to `task` (today's behavior).
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
    let reReviewLineSeen = false;
    let dispatchMode: DispatchMode = DEFAULT_DISPATCH_MODE;
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
            if (fields.length !== 1) {
                warnings.push(
                    `ROUTING line ${lineNo}: re-review takes exactly one ` +
                        `mode (line skipped)`,
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
            if (reReviewLineSeen) {
                warnings.push(
                    `ROUTING line ${lineNo}: duplicate re-review line ` +
                        `(last one wins)`,
                );
            }
            reReviewMode = mode as ReReviewMode;
            reReviewLineSeen = true;
            continue;
        }

        if (pattern === "dispatch") {
            if (fields.length !== 1) {
                warnings.push(
                    `ROUTING line ${lineNo}: dispatch takes exactly one ` +
                        `mode (line skipped)`,
                );
                continue;
            }
            const mode = fields[0];
            if (!(DISPATCH_MODES as readonly string[]).includes(mode)) {
                warnings.push(
                    `ROUTING line ${lineNo}: unknown dispatch mode ` +
                        `"${mode}" (kept ${dispatchMode})`,
                );
                continue;
            }
            if (dispatchLineSeen) {
                warnings.push(
                    `ROUTING line ${lineNo}: duplicate dispatch line ` +
                        `(last one wins)`,
                );
            }
            dispatchMode = mode as DispatchMode;
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
        dispatchMode,
        warnings,
    };
};
