/**
 * R10: the deterministic review router. It replaces the Haiku `reviewer-mapper`
 * sub-agent (R12) and the model-driven lens/tier routing that used to live in
 * `review.md` with pure, unit-testable TypeScript.
 *
 * Given the changed-file list (the existing `files.json`) and a small amount of
 * host-repo config (the linguist-generated globs from `.gitattributes`, the
 * `REVIEWERS` ownership rules, and the path->lens / path->tier tables a consumer
 * supplies), the router decides, deterministically:
 *
 *   - which files are generated (skip their contents) vs. real source;
 *   - which specialist lenses to spawn (only the ones whose paths are touched —
 *     this is what keeps the full eleven-lens roster from running on every PR);
 *   - which teams own the change (subsumes `reviewer-mapper`: same
 *     most-specific-pattern-wins + fallback-ranking behaviour, now in code);
 *   - a per-file risk tier; and
 *   - one run budget scaled by the highest touched tier, with one floor for
 *     misrouted PRs (task-3-2).
 *
 * Determinism boundary (plan §8.6): the core never calls a model. The *only*
 * judgement it cannot make from a path — a risk tier that depends on the
 * *direction* of the diff — is not guessed here. Such files are emitted in
 * `pendingRiskQuestions`; the orchestrator resolves them with one small-model
 * call and passes the answers back via `RouteInput.resolvedTiers` on a second
 * invocation. Until resolved, the router uses the conservative (highest
 * candidate) tier so the budget is never *understated*.
 *
 * This module authors no human-read prose (the R8 tripwire, plan §8.7): every
 * string it emits is a code, a path, a team slug, or a config value — never a
 * sentence about the code under review. Prose stays with the lens sub-agents.
 */

import {KNOWN_LENSES} from "./finding-schema";
import type {Lens} from "./finding-schema";

/* -------------------------------------------------------------------------- */
/* Lens taxonomy                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The always-on / whole-change reviewers and triage. These run every review
 * regardless of routing, so they are NOT part of the router's `lensesToSpawn`
 * (which names only the *specialist* lenses gated by touched paths). Kept here
 * as the complement of {@link SPECIALIST_LENSES} so the two lists cannot drift
 * from the canonical `KNOWN_LENSES`.
 */
export const ALWAYS_ON_LENSES = [
    "correctness",
    "conventions",
    "pattern-triage",
    "first-principles",
] as const;

// `satisfies readonly Lens[]` is the natural spelling, but the repo's
// prettier (2.6.2) cannot parse `satisfies`; this assignment keeps the same
// compile-time guarantee that every entry is a known Lens.
const ALWAYS_ON_SET: ReadonlySet<Lens> = new Set<Lens>(ALWAYS_ON_LENSES);

/**
 * The eleven specialist lenses the router dispatches by path. Derived from
 * `KNOWN_LENSES` minus the always-on set, and ordered as in `KNOWN_LENSES` so
 * `lensesToSpawn` has a stable, canonical order.
 */
export const SPECIALIST_LENSES: readonly Lens[] = KNOWN_LENSES.filter(
    (lens) => !ALWAYS_ON_SET.has(lens),
);

/* -------------------------------------------------------------------------- */
/* Risk tiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Per-file risk tiers, ordered from least to most risky. The order is load-
 * bearing: budget scaling and "highest touched tier" comparisons use the index
 * as the rank, so the run budget is monotonic in tier by construction.
 */
export const RISK_TIERS = ["trivial", "low", "medium", "high"] as const;

export type RiskTier = typeof RISK_TIERS[number];

const TIER_RANK: Record<RiskTier, number> = {
    trivial: 0,
    low: 1,
    medium: 2,
    high: 3,
};

/** The higher-risk of two tiers (ties return the first). */
const maxTier = (a: RiskTier, b: RiskTier): RiskTier =>
    TIER_RANK[b] > TIER_RANK[a] ? b : a;

/* -------------------------------------------------------------------------- */
/* Inputs, config, and outputs                                               */
/* -------------------------------------------------------------------------- */

/**
 * Git change status for a file. Mirrors the `status` field of the existing
 * `files.json` entries. The router only distinguishes these to reason about diff
 * direction where a rule opts in; the deterministic core does not otherwise
 * branch on status.
 */
export type FileStatus =
    | "added"
    | "modified"
    | "removed"
    | "renamed"
    | "copied"
    | "changed";

/** One entry of the changed-file list (`files.json`). */
export type ChangedFile = {
    path: string;
    status: FileStatus;
};

export type FileClassification = "generated" | "source";

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
 * rather than guess. See {@link RouteInput.resolvedTiers}.
 */
export type RiskRule = {
    pattern: string;
    tier: RiskTier;
    diffDirectionDependent?: boolean;
};

/** A parsed `REVIEWERS` ownership rule: a path glob and the teams that own it. */
export type ReviewerRule = {
    pattern: string;
    teams: string[];
};

/**
 * The run budget. All fields scale monotonically with {@link RunBudget.tier}.
 * `maxToolCallsPerFinding` is the field slice 5 (R9 investigation cap) reads —
 * the per-finding cap "lives inside the run budget from slice 3", so it is
 * defined here and derived from the tier rather than configured separately.
 */
export type RunBudget = {
    /** The tier whose budget was selected (after any misrouted floor). */
    tier: RiskTier;
    /** True when the misrouted floor lifted the budget above the touched tier. */
    floored: boolean;
    /** Upper bound on specialist+whole-change reviewer invocations for the run. */
    maxReviewerInvocations: number;
    /** R9: upper bound on investigation tool calls a single finding may spend. */
    maxToolCallsPerFinding: number;
    /** Upper bound on investigation tool calls across the whole run. */
    maxTotalToolCalls: number;
    /** Soft wall-clock ceiling (minutes) the orchestrator should target. */
    maxWallClockMinutes: number;
    /** Soft spend ceiling (USD) the orchestrator should target. */
    maxUsd: number;
};

export type RouterConfig = {
    /** linguist-generated globs (from `.gitattributes`). */
    generatedPatterns: string[];
    /** path->lens rules. Defaults to {@link DEFAULT_LENS_RULES}. */
    lensRules?: LensRule[];
    /** path->tier rules. Defaults to {@link DEFAULT_RISK_RULES}. */
    riskRules?: RiskRule[];
    /** Parsed `REVIEWERS` rules (see {@link parseReviewers}). */
    reviewerRules?: ReviewerRule[];
    /** Tier -> budget table. Defaults to {@link DEFAULT_TIER_BUDGETS}. */
    tierBudgets?: Record<RiskTier, RunBudget>;
    /** Tier a misrouted PR is floored to. Defaults to {@link DEFAULT_MISROUTED_FLOOR_TIER}. */
    misroutedFloorTier?: RiskTier;
    /** Tier assigned to a source file that matches no risk rule. Defaults to "low". */
    defaultTier?: RiskTier;
};

/** Per-file routing decision. */
export type FileRouting = {
    path: string;
    classification: FileClassification;
    tier: RiskTier;
    /** True when `tier` is a conservative placeholder awaiting model resolution. */
    tierPending: boolean;
    /** Specialist lenses matched for this file (empty for generated files). */
    lenses: Lens[];
    /** Owning teams for this file (empty for generated files or no match). */
    teams: string[];
};

/**
 * A file whose tier is diff-direction-dependent and not yet resolved. The
 * orchestrator answers exactly these with one small-model call and re-invokes
 * the router with the answers in {@link RouteInput.resolvedTiers}. `kind` is a
 * fixed code, not prose.
 */
export type RiskQuestion = {
    path: string;
    kind: "diff-direction-dependent";
    /** The distinct tiers the matched rules could resolve to. */
    candidateTiers: RiskTier[];
};

export type RoutingResult = {
    /** Specialist lenses to spawn, deduped, in canonical `KNOWN_LENSES` order. */
    lensesToSpawn: Lens[];
    /** Union of owning teams across the substantive (source) files. */
    teams: string[];
    /** Teams ranked by how many source files each owns (fallback pull-in order). */
    fallbackTeams: {team: string; files: number}[];
    /** Per-file tier, keyed by path (the field Step 7/8 of `review.md` reads). */
    perFileTier: Record<string, RiskTier>;
    /** Full per-file routing detail. */
    perFile: FileRouting[];
    /** The single run budget for this review. */
    runBudget: RunBudget;
    /** True when there are source files but no specialist lens matched any. */
    misrouted: boolean;
    /** Diff-direction-dependent files awaiting the orchestrator's small-model call. */
    pendingRiskQuestions: RiskQuestion[];
};

export type RouteInput = {
    files: ChangedFile[];
    /**
     * Second-pass answers for diff-direction-dependent files: path -> resolved
     * tier. A path present here is treated as finalised (not pending) and its
     * value wins over any rule-derived tier.
     */
    resolvedTiers?: Record<string, RiskTier>;
};

/* -------------------------------------------------------------------------- */
/* Documented defaults (tunable later; not HITL surfaces per refine cq-2/cq-4)*/
/* -------------------------------------------------------------------------- */

/**
 * Default budget table. These are the *assumed* caps (analysis §9 / plan §8:
 * the 20-min / $10 operator ceiling is a reasonable-default, not a HITL gate).
 * They scale monotonically across every field so the AC "budget scales
 * monotonically with tier" holds for the defaults, and are exported so the eval
 * suite and consumers can override them without a code change.
 */
export const DEFAULT_TIER_BUDGETS: Record<RiskTier, RunBudget> = {
    trivial: {
        tier: "trivial",
        floored: false,
        maxReviewerInvocations: 2,
        maxToolCallsPerFinding: 2,
        maxTotalToolCalls: 10,
        maxWallClockMinutes: 3,
        maxUsd: 0.5,
    },
    low: {
        tier: "low",
        floored: false,
        maxReviewerInvocations: 4,
        maxToolCallsPerFinding: 3,
        maxTotalToolCalls: 20,
        maxWallClockMinutes: 6,
        maxUsd: 1.5,
    },
    medium: {
        tier: "medium",
        floored: false,
        maxReviewerInvocations: 8,
        maxToolCallsPerFinding: 5,
        maxTotalToolCalls: 60,
        maxWallClockMinutes: 12,
        maxUsd: 4,
    },
    high: {
        tier: "high",
        floored: false,
        maxReviewerInvocations: 12,
        maxToolCallsPerFinding: 8,
        maxTotalToolCalls: 120,
        maxWallClockMinutes: 20,
        maxUsd: 10,
    },
};

/**
 * Tier a misrouted PR (source files touched, but no specialist lens matched) is
 * floored to. A misrouted PR still gets a real review from the always-on
 * reviewers, so it must not fall to the trivial budget just because no path
 * pattern claimed it. "low" is the documented default floor.
 */
export const DEFAULT_MISROUTED_FLOOR_TIER: RiskTier = "low";

/**
 * A generic starter path->lens table. Consumers are expected to override this
 * via config (`lensRules`) with their own repository layout — these defaults
 * key only on universally recognisable signals so the router does something
 * sensible out of the box and the fixture tests have a mapping to exercise.
 * Multiple matching rules union their lenses.
 */
export const DEFAULT_LENS_RULES: LensRule[] = [
    {pattern: "**/*.sql", lenses: ["data-migrations"]},
    {pattern: "**/migrations/**", lenses: ["data-migrations"]},
    {
        pattern: "**/*.proto",
        lenses: ["api-federation-compat", "cross-deploy-serialization"],
    },
    {pattern: "**/*.graphql", lenses: ["api-federation-compat"]},
    {pattern: "**/auth/**", lenses: ["security-auth"]},
    {pattern: "**/*.tf", lenses: ["deploy-infra-config"]},
    {pattern: "**/Dockerfile", lenses: ["deploy-infra-config"]},
    {pattern: "**/*.yaml", lenses: ["deploy-infra-config"]},
    {pattern: "**/*.yml", lenses: ["deploy-infra-config"]},
];

/**
 * A generic starter path->tier table. Like {@link DEFAULT_LENS_RULES}, consumers
 * override this via `riskRules`; the real risk taxonomy is the consumer's
 * `risk-classification.md`. The one `diffDirectionDependent` example (auth) shows
 * the mechanism: tightening vs. loosening an auth check is not decidable from the
 * path alone, so it defers to the orchestrator's small-model call.
 */
export const DEFAULT_RISK_RULES: RiskRule[] = [
    {pattern: "**/migrations/**", tier: "high"},
    {pattern: "**/*.sql", tier: "high"},
    {pattern: "**/auth/**", tier: "high", diffDirectionDependent: true},
    {pattern: "**/*.tf", tier: "medium"},
    {pattern: "**/Dockerfile", tier: "medium"},
    {pattern: "**/*.md", tier: "trivial"},
    {pattern: "**/*.txt", tier: "trivial"},
];

/* -------------------------------------------------------------------------- */
/* Glob matching (self-contained; CODEOWNERS/gitattributes-style)            */
/* -------------------------------------------------------------------------- */

/**
 * Compile a glob to an anchored RegExp. Semantics (a practical subset of
 * gitignore / CODEOWNERS):
 *   - `**`       matches any run of characters, including `/` (zero or more segments)
 *   - `*`        matches any run of characters except `/`
 *   - `?`        matches a single character except `/`
 *   - a trailing `/` makes the pattern a directory prefix (everything beneath it)
 *   - a leading `/` (optional) anchors to the repo root and is stripped
 *   - a pattern with NO `/` matches the file's *basename* in any directory
 *     (e.g. `*.lock`, `Dockerfile`), mirroring gitattributes/gitignore.
 * All other regex metacharacters are escaped literally.
 */
const globToRegExp = (glob: string): RegExp => {
    let pattern = glob.trim();

    // A no-slash pattern matches the basename anywhere: reduce to matching the
    // last path segment by prefixing an optional "any directories" group.
    const matchesBasename = !pattern.includes("/");

    // Directory pattern: trailing slash means "everything under this dir".
    let dirPrefix = false;
    if (pattern.endsWith("/")) {
        dirPrefix = true;
        pattern = pattern.slice(0, -1);
    }

    // Leading slash anchors to root; we always anchor, so just strip it.
    if (pattern.startsWith("/")) {
        pattern = pattern.slice(1);
    }

    let out = "";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // Consume the second star (and an optional following slash so
                // `**/x` matches `x` at the root as well as nested).
                i++;
                if (pattern[i + 1] === "/") {
                    i++;
                    out += "(?:.*/)?";
                } else {
                    out += ".*";
                }
            } else {
                out += "[^/]*";
            }
        } else if (ch === "?") {
            out += "[^/]";
        } else {
            // Escape any regex-special character.
            out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
    }

    if (dirPrefix) {
        // Match the directory itself and anything beneath it.
        out += "(?:/.*)?";
    }

    const body = matchesBasename ? `(?:.*/)?${out}` : out;
    return new RegExp(`^${body}$`);
};

// Compiled-pattern cache: patterns come from static config, so caching keeps
// repeated `route` calls (and large file lists) from recompiling.
const regexpCache = new Map<string, RegExp>();

const compile = (glob: string): RegExp => {
    let re = regexpCache.get(glob);
    if (re === undefined) {
        re = globToRegExp(glob);
        regexpCache.set(glob, re);
    }
    return re;
};

/** Whether `path` matches `glob` under the semantics in {@link globToRegExp}. */
export const matchesGlob = (path: string, glob: string): boolean =>
    compile(glob).test(path);

/**
 * Specificity score for "most specific pattern wins" (CODEOWNERS-style). More
 * literal (non-wildcard) characters is more specific; ties break on total
 * length, then on having more path segments. Higher wins.
 */
export const patternSpecificity = (glob: string): number => {
    const literal = glob.replace(/[*?]/g, "").length;
    const segments = glob.split("/").length;
    return literal * 1000 + glob.length * 10 + segments;
};

/* -------------------------------------------------------------------------- */
/* Config parsers (pure: content-in, structure-out — CLI does the file read) */
/* -------------------------------------------------------------------------- */

/**
 * Extract the linguist-generated globs from `.gitattributes` content. A line
 * assigns attributes to a pattern: `<pattern> attr1 attr2 ...`. We collect the
 * pattern when it sets `linguist-generated` truthy, and honour explicit
 * negation (`-linguist-generated` or `linguist-generated=false`).
 */
export const parseGitattributesGenerated = (content: string): string[] => {
    const patterns: string[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const tokens = line.split(/\s+/);
        const pattern = tokens[0];
        if (pattern === undefined) {
            continue;
        }
        const attrs = tokens.slice(1);
        let generated = false;
        for (const attr of attrs) {
            if (
                attr === "linguist-generated" ||
                attr === "linguist-generated=true"
            ) {
                generated = true;
            } else if (
                attr === "-linguist-generated" ||
                attr === "linguist-generated=false"
            ) {
                generated = false;
            }
        }
        if (generated) {
            patterns.push(pattern);
        }
    }
    return patterns;
};

/**
 * Normalise a `REVIEWERS`/CODEOWNERS team token to a slug: strip the leading
 * `@`, drop the org prefix (`@Org/Team` -> `Team`), remove a trailing `!`, and
 * lowercase. Mirrors the `reviewer-mapper` prompt's rule exactly.
 */
export const teamSlug = (token: string): string => {
    let slug = token.trim();
    if (slug.startsWith("@")) {
        slug = slug.slice(1);
    }
    const slash = slug.lastIndexOf("/");
    if (slash !== -1) {
        slug = slug.slice(slash + 1);
    }
    if (slug.endsWith("!")) {
        slug = slug.slice(0, -1);
    }
    return slug.toLowerCase();
};

/**
 * Parse a `REVIEWERS` file into ownership rules. Skips blanks, `#` comments, and
 * `[SECTION]` header lines (e.g. `[ON PULL REQUEST]`). Each remaining line is
 * `<pattern> <team> [<team> ...]`; teams are normalised via {@link teamSlug}.
 */
export const parseReviewers = (content: string): ReviewerRule[] => {
    const rules: ReviewerRule[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#") || line.startsWith("[")) {
            continue;
        }
        const tokens = line.split(/\s+/);
        const pattern = tokens[0];
        if (pattern === undefined) {
            continue;
        }
        const teams = tokens
            .slice(1)
            .map(teamSlug)
            .filter((slug) => slug.length > 0);
        rules.push({pattern, teams});
    }
    return rules;
};

/* -------------------------------------------------------------------------- */
/* Per-file decisions                                                        */
/* -------------------------------------------------------------------------- */

/** Whether `path` matches any linguist-generated glob. */
export const isGenerated = (
    path: string,
    generatedPatterns: string[],
): boolean => generatedPatterns.some((pattern) => matchesGlob(path, pattern));

/** Specialist lenses for one path (union of all matching rules, deduped). */
const lensesForFile = (path: string, lensRules: LensRule[]): Lens[] => {
    const matched = new Set<Lens>();
    for (const rule of lensRules) {
        if (matchesGlob(path, rule.pattern)) {
            for (const lens of rule.lenses) {
                matched.add(lens);
            }
        }
    }
    // Canonical order.
    return SPECIALIST_LENSES.filter((lens) => matched.has(lens));
};

/**
 * Owning teams for one path: the *most specific* matching `REVIEWERS` rule wins
 * (CODEOWNERS-style), and that rule's team list is returned. No match -> [].
 */
const teamsForFile = (
    path: string,
    reviewerRules: ReviewerRule[],
): string[] => {
    let best: ReviewerRule | undefined;
    let bestScore = -1;
    for (const rule of reviewerRules) {
        if (matchesGlob(path, rule.pattern)) {
            const score = patternSpecificity(rule.pattern);
            if (score > bestScore) {
                bestScore = score;
                best = rule;
            }
        }
    }
    return best ? [...best.teams] : [];
};

type TierDecision = {
    tier: RiskTier;
    pending: boolean;
    candidates: RiskTier[];
};

/**
 * Risk tier for one file. A resolved answer (second pass) is authoritative. Else
 * the tier is the highest among matching rules; if any matching rule is
 * diff-direction-dependent, the decision is `pending` (conservative tier now, a
 * question emitted for the orchestrator). No matching rule -> the configured
 * default tier.
 */
const tierForFile = (
    file: ChangedFile,
    riskRules: RiskRule[],
    defaultTier: RiskTier,
    resolvedTiers: Record<string, RiskTier> | undefined,
): TierDecision => {
    const resolved = resolvedTiers?.[file.path];
    if (resolved !== undefined) {
        return {tier: resolved, pending: false, candidates: [resolved]};
    }

    const matches = riskRules.filter((rule) =>
        matchesGlob(file.path, rule.pattern),
    );
    if (matches.length === 0) {
        return {tier: defaultTier, pending: false, candidates: [defaultTier]};
    }

    const candidateSet = new Set<RiskTier>();
    let tier: RiskTier = "trivial";
    let pending = false;
    for (const rule of matches) {
        candidateSet.add(rule.tier);
        tier = maxTier(tier, rule.tier);
        if (rule.diffDirectionDependent === true) {
            pending = true;
        }
    }
    const candidates = RISK_TIERS.filter((t) => candidateSet.has(t));
    return {tier, pending, candidates};
};

/* -------------------------------------------------------------------------- */
/* Budget                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single budget rule (task-3-2): scale by the highest touched tier, with one
 * floor for misrouted PRs. No per-lens knobs. When misrouted and the floor tier
 * outranks the touched tier, the floor's budget is used and `floored` is set.
 */
export const computeRunBudget = (
    highestTier: RiskTier,
    misrouted: boolean,
    config: RouterConfig,
): RunBudget => {
    const table = config.tierBudgets ?? DEFAULT_TIER_BUDGETS;
    const floorTier = config.misroutedFloorTier ?? DEFAULT_MISROUTED_FLOOR_TIER;

    let effectiveTier = highestTier;
    let floored = false;
    if (misrouted && TIER_RANK[floorTier] > TIER_RANK[highestTier]) {
        effectiveTier = floorTier;
        floored = true;
    }

    return {...table[effectiveTier], tier: effectiveTier, floored};
};

/* -------------------------------------------------------------------------- */
/* Top-level routing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Route a changed-file list to lenses, teams, per-file tiers, and one run
 * budget. Pure and deterministic: same input + config -> same result, with no
 * I/O and no model call (the sole model touch is externalised via
 * `pendingRiskQuestions`; plan §8.6).
 */
export const route = (
    input: RouteInput,
    config: RouterConfig,
): RoutingResult => {
    const lensRules = config.lensRules ?? DEFAULT_LENS_RULES;
    const riskRules = config.riskRules ?? DEFAULT_RISK_RULES;
    const reviewerRules = config.reviewerRules ?? [];
    const defaultTier = config.defaultTier ?? "low";

    const perFile: FileRouting[] = [];
    const perFileTier: Record<string, RiskTier> = {};
    const lensSet = new Set<Lens>();
    const teamFileCount = new Map<string, number>();
    const pendingRiskQuestions: RiskQuestion[] = [];

    let highestTier: RiskTier = "trivial";
    let hasSource = false;

    for (const file of input.files) {
        const generated = isGenerated(file.path, config.generatedPatterns);

        if (generated) {
            // Generated files: contents are not analysed, so no lenses, no team
            // ownership, and the lowest tier. They never drive routing.
            perFile.push({
                path: file.path,
                classification: "generated",
                tier: "trivial",
                tierPending: false,
                lenses: [],
                teams: [],
            });
            perFileTier[file.path] = "trivial";
            continue;
        }

        hasSource = true;

        const lenses = lensesForFile(file.path, lensRules);
        for (const lens of lenses) {
            lensSet.add(lens);
        }

        const teams = teamsForFile(file.path, reviewerRules);
        for (const team of teams) {
            teamFileCount.set(team, (teamFileCount.get(team) ?? 0) + 1);
        }

        const {tier, pending, candidates} = tierForFile(
            file,
            riskRules,
            defaultTier,
            input.resolvedTiers,
        );
        highestTier = maxTier(highestTier, tier);
        if (pending) {
            pendingRiskQuestions.push({
                path: file.path,
                kind: "diff-direction-dependent",
                candidateTiers: candidates,
            });
        }

        perFile.push({
            path: file.path,
            classification: "source",
            tier,
            tierPending: pending,
            lenses,
            teams,
        });
        perFileTier[file.path] = tier;
    }

    const lensesToSpawn = SPECIALIST_LENSES.filter((lens) => lensSet.has(lens));

    // A PR is "misrouted" when it changes real source but no specialist lens
    // claimed any of it — it still gets the always-on reviewers, so it must not
    // be starved of budget. An all-generated (or empty) PR is not misrouted.
    const misrouted = hasSource && lensesToSpawn.length === 0;

    const teams = [...teamFileCount.keys()].sort();
    const fallbackTeams = [...teamFileCount.entries()]
        .map(([team, files]) => ({team, files}))
        // Most-owned first; ties broken alphabetically for determinism.
        .sort((a, b) => b.files - a.files || a.team.localeCompare(b.team));

    const runBudget = computeRunBudget(highestTier, misrouted, config);

    return {
        lensesToSpawn,
        teams,
        fallbackTeams,
        perFileTier,
        perFile,
        runBudget,
        misrouted,
        pendingRiskQuestions,
    };
};

/* -------------------------------------------------------------------------- */
/* Serialization to the routing.json contract review.md consumes             */
/* -------------------------------------------------------------------------- */

/**
 * review.md (Step 3) uses a capitalized tier vocabulary in routing.json
 * ("High|Medium|Low|Trivial"), whereas the pure core uses lowercase tiers
 * (consistent with the rest of the lib). The casing is bridged here, at the
 * I/O boundary, so the core stays lowercase and the emitted JSON matches the
 * consumed contract.
 */
export type DisplayTier = "Trivial" | "Low" | "Medium" | "High";

const TIER_TO_DISPLAY: Record<RiskTier, DisplayTier> = {
    trivial: "Trivial",
    low: "Low",
    medium: "Medium",
    high: "High",
};

/**
 * Parse a tier from either the display casing (routing.json / resolved-tiers
 * input) or the internal lowercase casing. Unknown values fall back to "low".
 */
export const tierFromDisplay = (value: string): RiskTier => {
    switch (value) {
        case "Trivial":
        case "trivial":
            return "trivial";
        case "Low":
        case "low":
            return "low";
        case "Medium":
        case "medium":
            return "medium";
        case "High":
        case "high":
            return "high";
        default:
            return "low";
    }
};

/**
 * The exact shape review.md's Step 3 documents and Steps 7/8 consume. `teams`
 * is nested as `{owners, fallback}` (Step 7 groups by owner; Step 8 maps
 * reviewers from owners and falls back via the ranked list — exactly the
 * `owners`/`fallbackTeams` the removed `reviewer-mapper` produced). `perFileTier`
 * uses the display casing. `pendingRiskQuestions` carries the router's one
 * bounded question so the orchestrator can run the documented second pass; it
 * is absent (empty) when the first pass is already final.
 */
export type RoutingJson = {
    lensesToSpawn: Lens[];
    teams: {
        owners: Record<string, string[]>;
        fallback: {team: string; files: number}[];
    };
    perFileTier: Record<string, DisplayTier>;
    runBudget: RunBudget;
    pendingRiskQuestions: RiskQuestion[];
};

/**
 * Adapt a {@link RoutingResult} to the {@link RoutingJson} contract. `owners`
 * is the per-file team map over the substantive (source) files only — generated
 * files carry no ownership, mirroring the old `owned-files.json` scope. Pure and
 * deterministic; exported so the serialization shape is unit-testable.
 */
export const toRoutingJson = (result: RoutingResult): RoutingJson => {
    const owners: Record<string, string[]> = {};
    for (const file of result.perFile) {
        if (file.classification === "source") {
            owners[file.path] = file.teams;
        }
    }

    const perFileTier: Record<string, DisplayTier> = {};
    for (const [path, tier] of Object.entries(result.perFileTier)) {
        perFileTier[path] = TIER_TO_DISPLAY[tier];
    }

    return {
        lensesToSpawn: result.lensesToSpawn,
        teams: {owners, fallback: result.fallbackTeams},
        perFileTier,
        runBudget: result.runBudget,
        pendingRiskQuestions: result.pendingRiskQuestions,
    };
};

/* -------------------------------------------------------------------------- */
/* CLI entrypoint (Surface A — review.md Step 3 invokes this file directly)   */
/* -------------------------------------------------------------------------- */

/**
 * Staging paths, extending #194's on-disk convention. review.md Step 1 stages
 * `files.json`; the router reads it, `.gitattributes`, and `.github/REVIEWERS`
 * (relative to the checkout root, the workflow's cwd), and writes `routing.json`.
 * The deterministic core does not read `full.diff`: the only diff-content
 * judgement (direction-dependent tiers) is externalised to the orchestrator's
 * small-model call, not parsed here (plan §8.6).
 */
const REVIEW_DIR = "/tmp/gh-aw/review";
const FILES_PATH = `${REVIEW_DIR}/files.json`;
const ROUTING_OUT = `${REVIEW_DIR}/routing.json`;
/** Optional second-pass input: {path: tier} answers for pending questions. */
const RESOLVED_TIERS_PATH = `${REVIEW_DIR}/resolved-tiers.json`;
const GITATTRIBUTES_PATH = ".gitattributes";
const REVIEWERS_PATH = ".github/REVIEWERS";

type FsLike = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
};

/**
 * Read + parse the staged inputs, run {@link route}, and write `routing.json` in
 * the {@link RoutingJson} shape. Factored out (fs injected) so it is testable
 * without touching the real filesystem. Returns the written JSON.
 */
/** Accept either a bare `[{path,status}]` array or a `{files:[…]}` wrapper. */
const extractFileList = (raw: unknown): unknown[] => {
    if (Array.isArray(raw)) {
        return raw;
    }
    const wrapped = (raw as {files?: unknown}).files;
    return Array.isArray(wrapped) ? wrapped : [];
};

export const runCli = (fs: FsLike): RoutingJson => {
    const readText = (p: string): string => fs.readFileSync(p, "utf8");

    const files: ChangedFile[] = extractFileList(
        JSON.parse(readText(FILES_PATH)),
    ).map((entry) => {
        const rec = entry as {path?: unknown; status?: unknown};
        return {
            path: String(rec.path ?? ""),
            status: (rec.status ?? "modified") as FileStatus,
        };
    });

    const generatedPatterns = fs.existsSync(GITATTRIBUTES_PATH)
        ? parseGitattributesGenerated(readText(GITATTRIBUTES_PATH))
        : [];
    const reviewerRules = fs.existsSync(REVIEWERS_PATH)
        ? parseReviewers(readText(REVIEWERS_PATH))
        : [];

    const input: RouteInput = {files};
    if (fs.existsSync(RESOLVED_TIERS_PATH)) {
        const raw: Record<string, unknown> = JSON.parse(
            readText(RESOLVED_TIERS_PATH),
        );
        const resolvedTiers: Record<string, RiskTier> = {};
        for (const [path, value] of Object.entries(raw)) {
            resolvedTiers[path] = tierFromDisplay(String(value));
        }
        input.resolvedTiers = resolvedTiers;
    }

    const result = route(input, {generatedPatterns, reviewerRules});
    const json = toRoutingJson(result);

    fs.mkdirSync(REVIEW_DIR, {recursive: true});
    fs.writeFileSync(ROUTING_OUT, JSON.stringify(json, null, 2));
    return json;
};

// Run only when executed directly (review.md Step 3), never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    const fs = require("node:fs") as FsLike;
    runCli(fs);
}
