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

/** Parsed `.github/aw/review/ROUTING` config. */
export type RoutingFileConfig = {
    lensRules: LensRule[];
    riskRules: RiskRule[];
    /** Fixed-format parse warnings (unknown lens/tier, no-op rule). */
    warnings: string[];
};

const KNOWN_LENS_SET: ReadonlySet<string> = new Set(KNOWN_LENSES);

/**
 * Parse the consumer-owned routing map. Line grammar, `REVIEWERS`-style —
 * blanks and `#` comments skipped, one rule per line:
 *
 *     <pattern> [lens=<lens>[,<lens>…]] [tier=trivial|low|medium|high] [direction-dependent]
 *
 * `lens=` names specialist lenses to spawn when the pattern is touched (multiple
 * matching rules union their lenses). `tier=` assigns a risk tier (the highest
 * matching rule wins). `direction-dependent` marks a tier that cannot be
 * finalised from the path alone (tightening vs. loosening; see
 * {@link RiskRule.diffDirectionDependent}) and requires `tier=`.
 *
 * Malformed fields and unknown lens names produce a warning and skip the lens or
 * line rather than aborting the run: routing degrades to fewer lenses, never to
 * a crashed review.
 */
export const parseRoutingConfig = (content: string): RoutingFileConfig => {
    const lensRules: LensRule[] = [];
    const riskRules: RiskRule[] = [];
    const warnings: string[] = [];

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const lineNo = index + 1;
        const [pattern, ...fields] = line.split(/\s+/);

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

    return {lensRules, riskRules, warnings};
};
