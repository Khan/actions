/**
 * Consumer-config checker: validates a repo's `.github/aw/review/` install of
 * the shared PR reviewer against the *same* code the workflow runs.
 *
 * Onboarding a repo means writing five files by hand (`config.md`,
 * `risk-classification.md`, `ci-tooling.md`, `skills.md`, `ROUTING`) and making
 * two local edits to the installed `review.md`. Every mistake in that set fails
 * *late* and quietly: a missing `{{#runtime-import}}` target surfaces as
 * `Runtime import file not found` on the next PR rather than at `gh aw compile`
 * time; `add-reviewer` defined in `review.md` as well as `config.md` silently
 * discards the consumer's team allowlist (the main workflow wins); a `ROUTING`
 * typo degrades to fewer lenses and a floored budget, visible only as a `Note:`
 * on a review that already happened; an active `observability:` block without
 * both `GH_AW_OTEL_SENTRY_*` secrets kills the agent job at startup.
 *
 * So this module answers "would this install work, and does it route the way
 * the author intended?" *before* the first PR. It never reimplements routing
 * semantics: tiers, lenses, generated-file classification and the budget all
 * come from {@link route}, `ROUTING` is read by {@link parseRoutingConfig}, and
 * `.gitattributes` by {@link parseGitattributesGenerated}. A release that
 * changes those semantics changes this checker's answers for free, which is why
 * it ships in `lib/` beside them and is run from the tag the repo pins.
 *
 * Usage (from a checkout of this repo at the tag the consumer pins):
 *
 *     git ls-files | npx -y tsx workflows/review/lib/check-consumer-config.ts \
 *         --repo ../consumer-repo --files-from -
 *     npx -y tsx workflows/review/lib/check-consumer-config.ts \
 *         --repo ../consumer-repo --explain plugins/foo/skills/bar/SKILL.md
 *
 * Errors exit 1; warnings exit 0 unless `--strict`. `--json` prints the report
 * instead of the text rendering.
 */

import {
    isGenerated,
    parseGitattributesGenerated,
    parseRoutingConfig,
    RISK_TIERS,
    ROUTING_CONFIG_PATH,
    route,
    matchesGlob,
    lensPayloadWarnings,
    SPECIALIST_LENSES,
    CORRECTNESS_ALIAS_PATH,
    LENS_PAYLOAD_DIR,
    DEFAULT_RE_REVIEW_MODE,
} from "./router";
import type {ChangedFile, RoutingResult} from "./router";
import {
    frontmatterBlock,
    hasKey,
    items,
    nested,
    nestedPath,
    scalar,
    yamlLines,
} from "./frontmatter";
import type {
    EnableableReviewer,
    ReReviewMode,
    RiskRule,
    RiskTier,
} from "./routing-config";
import type {Lens} from "./finding-schema";

/* -------------------------------------------------------------------------- */
/* Paths the install contract fixes                                          */
/* -------------------------------------------------------------------------- */

/** Where every consumer config file lives. */
export const CONSUMER_CONFIG_DIR = ".github/aw/review";

/**
 * The compile-time frontmatter import (`imports:` in `review.md`). A missing one
 * fails `gh aw compile`; a *wrong* one (no `add-reviewer`, empty allowlist)
 * compiles fine and never requests a reviewer.
 */
export const CONFIG_IMPORT_PATH = `${CONSUMER_CONFIG_DIR}/config.md`;

/**
 * The required `{{#runtime-import}}` bodies. They resolve when the workflow
 * *runs*, so a missing one is a red run on someone's PR, not a compile error.
 */
export const REQUIRED_RUNTIME_IMPORTS = [
    `${CONSUMER_CONFIG_DIR}/risk-classification.md`,
    `${CONSUMER_CONFIG_DIR}/ci-tooling.md`,
    `${CONSUMER_CONFIG_DIR}/skills.md`,
] as const;

/** Default location `gh aw add Khan/actions/workflows/review/review.md` writes. */
export const INSTALLED_WORKFLOW_PATH = ".github/workflows/review.md";

/** Compiled output of the installed workflow (`gh aw compile`). */
export const INSTALLED_LOCK_PATH = ".github/workflows/review.lock.yml";

const GITATTRIBUTES_PATH = ".gitattributes";

/**
 * Copilot Agent scaffolding `gh aw` writes on first init. Unused at Khan, and it
 * reads as part of the reviewer install; both known consumers removed it.
 */
export const COPILOT_SCAFFOLDING = [
    ".github/mcp.json",
    ".github/agents",
    ".github/skills",
    ".github/workflows/copilot-setup-steps.yml",
] as const;

/**
 * The `max-ai-credits` the shared workflow ships. Both known consumers raise it:
 * `tier=high` runs have died at ~1001-1024 metered credits *after* computing a
 * verdict but before posting it.
 */
export const SHIPPED_MAX_AI_CREDITS = 1000;

/* -------------------------------------------------------------------------- */
/* Report shape                                                              */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = "error" | "warning";

/**
 * One finding. `code` is a fixed machine token; `message` states the defect and
 * `fix` the action that clears it.
 */
export type ConfigIssue = {
    severity: IssueSeverity;
    code: string;
    message: string;
    fix?: string;
};

/** What the installed `review.md` frontmatter says. */
export type InstalledWorkflow = {
    present: boolean;
    lockPresent: boolean;
    /** The `source:` field gh-aw records, verbatim (undefined when absent). */
    source?: string;
    /** The `@<ref>` half of `source:`, when it carries one. */
    pinnedRef?: string;
    importsConfig: boolean;
    /** True when the main workflow also defines `add-reviewer` (overrides the import). */
    definesAddReviewer: boolean;
    maxAiCredits?: number;
    /** True when the `observability:` block is live (not commented out). */
    observabilityActive: boolean;
};

/** What `config.md`'s frontmatter says. */
export type ReviewerRouting = {
    present: boolean;
    definesAddReviewer: boolean;
    allowedTeamReviewers: string[];
    /** True when `add-reviewer` names a `github-token:` (org teams need one). */
    hasGithubToken: boolean;
};

/** Tier resolution over a supplied file list, from {@link route}. */
export type TierPreview = {
    fileCount: number;
    generated: number;
    counts: Record<RiskTier, number>;
    /** Up to {@link SAMPLE_LIMIT} paths per tier, in input order. */
    samples: Record<RiskTier, string[]>;
    /** Source files no `tier=` rule matched: the router's default tier applies. */
    unmatched: string[];
    /**
     * `ROUTING` patterns that match no tracked file at all. A dead pattern parses
     * clean and routes nothing, so a typo is invisible without this.
     */
    deadPatterns: string[];
    lensesToSpawn: Lens[];
    highestTier: RiskTier;
};

/** One path's routing decision plus the rules that produced it. */
export type PathExplanation = {
    path: string;
    generated: boolean;
    tier: RiskTier;
    tierPending: boolean;
    /** Every `tier=` rule matching this path, in file order (last one wins). */
    matchingTierRules: RiskRule[];
    lenses: Lens[];
};

export type ConsumerConfigReport = {
    repoRoot: string;
    issues: ConfigIssue[];
    routing: {
        present: boolean;
        enabledReviewers: EnableableReviewer[];
        reReviewMode: ReReviewMode;
        tierRules: number;
        lensRules: number;
    };
    installedWorkflow: InstalledWorkflow;
    reviewerRouting: ReviewerRouting;
    /** Tier of each config file that steers the reviewer (self-tamper check). */
    configFileTiers: Record<string, RiskTier>;
    tierPreview?: TierPreview;
    explanation?: PathExplanation;
};

const SAMPLE_LIMIT = 5;

/* -------------------------------------------------------------------------- */
/* Checks                                                                    */
/* -------------------------------------------------------------------------- */

/** The filesystem surface this module needs (injected, so tests stay in memory). */
export type FsLike = {
    readFileSync: (p: string, enc: "utf8") => string;
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
};

export type CheckOptions = {
    /** Consumer repo root. */
    repoRoot?: string;
    /** Tracked paths to preview tier routing over (e.g. `git ls-files`). */
    files?: readonly string[];
    /** One path to explain in full. */
    explainPath?: string;
    /** Installed workflow path, when the repo renamed it. */
    workflowPath?: string;
    /**
     * The `review` package version this checker was run from. When set, a
     * consumer pinned to a different `review-v*` tag is warned: the semantics
     * validated here are this version's, not the one their PRs will run.
     */
    checkerVersion?: string;
};

const emptyTierRecord = <T>(make: () => T): Record<RiskTier, T> => ({
    trivial: make(),
    low: make(),
    medium: make(),
    high: make(),
});

const readInstalledWorkflow = (fs: FsLike, path: string): InstalledWorkflow => {
    if (!fs.existsSync(path)) {
        return {
            present: false,
            lockPresent: false,
            importsConfig: false,
            definesAddReviewer: false,
            observabilityActive: false,
        };
    }
    const content = fs.readFileSync(path, "utf8");
    const block = frontmatterBlock(content);
    const lines = block === undefined ? [] : yamlLines(block);

    const source = scalar(lines, "source");
    const atIndex = source?.lastIndexOf("@") ?? -1;
    const pinnedRef =
        source !== undefined && atIndex > 0
            ? source.slice(atIndex + 1)
            : undefined;

    const imports = nested(lines, "imports") ?? [];
    const credits = scalar(lines, "max-ai-credits");

    return {
        present: true,
        lockPresent: false, // filled by the caller (path may be renamed)
        source,
        pinnedRef,
        importsConfig: imports.some((line) => line.item === CONFIG_IMPORT_PATH),
        definesAddReviewer:
            nestedPath(lines, ["safe-outputs", "add-reviewer"]) !== undefined,
        maxAiCredits: credits === undefined ? undefined : Number(credits),
        observabilityActive: hasKey(lines, "observability"),
    };
};

const readReviewerRouting = (fs: FsLike, path: string): ReviewerRouting => {
    if (!fs.existsSync(path)) {
        return {
            present: false,
            definesAddReviewer: false,
            allowedTeamReviewers: [],
            hasGithubToken: false,
        };
    }
    const block = frontmatterBlock(fs.readFileSync(path, "utf8"));
    const lines = block === undefined ? [] : yamlLines(block);
    const addReviewer = nestedPath(lines, ["safe-outputs", "add-reviewer"]);
    const teams = nestedPath(lines, [
        "safe-outputs",
        "add-reviewer",
        "allowed-team-reviewers",
    ]);
    return {
        present: true,
        definesAddReviewer: addReviewer !== undefined,
        allowedTeamReviewers: items(teams ?? []),
        hasGithubToken:
            addReviewer !== undefined && hasKey(addReviewer, "github-token"),
    };
};

/**
 * Run every check. Pure apart from the injected `fs`: the caller supplies the
 * file list (so the checker never shells out to git) and the report is data,
 * rendered separately.
 */
export const checkConsumerConfig = (
    fs: FsLike,
    options: CheckOptions = {},
): ConsumerConfigReport => {
    const repoRoot = options.repoRoot ?? ".";
    const at = (p: string): string =>
        repoRoot === "." ? p : `${repoRoot}/${p}`;
    const issues: ConfigIssue[] = [];
    const error = (code: string, message: string, fix?: string): void => {
        issues.push({severity: "error", code, message, fix});
    };
    const warn = (code: string, message: string, fix?: string): void => {
        issues.push({severity: "warning", code, message, fix});
    };

    /* --- required config files --------------------------------------------- */

    const requireFile = (path: string, why: string): string | undefined => {
        if (!fs.existsSync(at(path))) {
            error(
                "missing-required-config",
                `${path} is missing. ${why}`,
                `Create ${path}.`,
            );
            return undefined;
        }
        const content = fs.readFileSync(at(path), "utf8");
        if (content.trim() === "") {
            error(
                "empty-required-config",
                `${path} is empty. ${why}`,
                `Write ${path}, or the reviewer runs with no repo-specific guidance.`,
            );
            return undefined;
        }
        return content;
    };

    requireFile(
        CONFIG_IMPORT_PATH,
        "It is a compile-time `imports:` target, so `gh aw compile` fails without it.",
    );
    for (const path of REQUIRED_RUNTIME_IMPORTS) {
        const content = requireFile(
            path,
            "It is a required `{{#runtime-import}}`, so the next PR's review fails at run time without it.",
        );
        // gh-aw rejects Actions template expressions inside imported bodies.
        // `config.md` is exempt: it is a frontmatter import and legitimately
        // carries `${{ secrets.* }}` for the bot token.
        if (content !== undefined && content.includes("${{")) {
            error(
                "template-expression-in-import",
                `${path} contains a \`\${{ }}\` expression; gh-aw rejects those inside runtime imports.`,
                "Remove the expression, or move the value into the installed review.md.",
            );
        }
    }

    /* --- ROUTING ----------------------------------------------------------- */

    const routingPresent = fs.existsSync(at(ROUTING_CONFIG_PATH));
    const routingConfig = routingPresent
        ? parseRoutingConfig(fs.readFileSync(at(ROUTING_CONFIG_PATH), "utf8"))
        : undefined;

    if (!routingPresent) {
        warn(
            "routing-missing",
            `${ROUTING_CONFIG_PATH} is absent: no specialist lens spawns, the run budget is floored, and every review carries a missing-config note.`,
            "Write ROUTING with this repo's tier rules and `enable` roster.",
        );
    }
    for (const warning of routingConfig?.warnings ?? []) {
        warn(
            "routing-parse-warning",
            warning,
            "Fix the line; a skipped rule routes fewer reviewers, silently.",
        );
    }
    if (
        routingConfig !== undefined &&
        routingConfig.enabledReviewers.length === 0
    ) {
        warn(
            "no-enabled-reviewers",
            "ROUTING has no `enable` line: only the default roster runs (pattern-triage, correctness-reviewer, skill-auditor, thread-reconciler, claim-validator).",
            "Both known consumers enable holistic,completeness,test-adequacy,first-principles,conventions.",
        );
    }
    if (
        routingConfig !== undefined &&
        routingConfig.reReviewMode === DEFAULT_RE_REVIEW_MODE
    ) {
        warn(
            "re-review-full",
            "ROUTING sets no `re-review` mode, so every push re-runs the whole roster over the whole diff (the most expensive setting).",
            "`re-review scoped` is the recommended first step down; see the README's re-review table.",
        );
    }

    const lensRules = routingConfig?.lensRules ?? [];
    const riskRules = routingConfig?.riskRules ?? [];

    /* --- lens payloads ----------------------------------------------------- */

    const lensesDir = at(LENS_PAYLOAD_DIR);
    let payloadFiles: string[] = [];
    if (fs.existsSync(lensesDir)) {
        try {
            payloadFiles = fs.readdirSync(lensesDir);
        } catch {
            warn(
                "lens-dir-unreadable",
                `${LENS_PAYLOAD_DIR} exists but is not a readable directory; no payload is imported.`,
            );
        }
    }
    for (const warning of lensPayloadWarnings(
        payloadFiles,
        lensRules,
        fs.existsSync(at(CORRECTNESS_ALIAS_PATH)),
        SPECIALIST_LENSES,
    )) {
        warn("lens-payload-warning", warning);
    }
    for (const path of payloadFiles) {
        const full = `${LENS_PAYLOAD_DIR}/${path}`;
        if (
            path.endsWith(".md") &&
            fs.readFileSync(at(full), "utf8").includes("${{")
        ) {
            error(
                "template-expression-in-import",
                `${full} contains a \`\${{ }}\` expression; gh-aw rejects those inside runtime imports.`,
            );
        }
    }

    /* --- installed workflow ------------------------------------------------ */

    const workflowPath = options.workflowPath ?? INSTALLED_WORKFLOW_PATH;
    const lockPath =
        workflowPath === INSTALLED_WORKFLOW_PATH
            ? INSTALLED_LOCK_PATH
            : workflowPath.replace(/\.md$/, ".lock.yml");
    const installed = readInstalledWorkflow(fs, at(workflowPath));
    installed.lockPresent = fs.existsSync(at(lockPath));

    if (!installed.present) {
        error(
            "workflow-not-installed",
            `${workflowPath} is missing: the reviewer is not installed.`,
            "Run `gh aw add Khan/actions/workflows/review/review.md@review-v<major>.<minor>.<patch>`.",
        );
    } else {
        if (!installed.lockPresent) {
            error(
                "lock-missing",
                `${lockPath} is missing, so nothing runs: the compiled lock is the workflow GitHub executes.`,
                "Run `gh aw compile` and commit the lock.",
            );
        }
        if (!installed.importsConfig) {
            error(
                "workflow-missing-config-import",
                `${workflowPath} does not import ${CONFIG_IMPORT_PATH}, so this repo's add-reviewer allowlist never reaches the workflow.`,
                `Restore \`imports:\` with \`- ${CONFIG_IMPORT_PATH}\`.`,
            );
        }
        if (installed.definesAddReviewer) {
            error(
                "workflow-defines-add-reviewer",
                `${workflowPath} defines \`add-reviewer\` itself; gh-aw lets the main workflow override an imported safe output of the same type, so the allowlist in ${CONFIG_IMPORT_PATH} is discarded.`,
                `Delete the \`add-reviewer\` block from ${workflowPath}; it belongs only in config.md.`,
            );
        }
        if (installed.source === undefined) {
            warn(
                "source-missing",
                `${workflowPath} carries no \`source:\` field, so \`gh aw update\` cannot find its upstream.`,
            );
        } else if (installed.pinnedRef === undefined) {
            warn(
                "source-unpinned",
                `${workflowPath} tracks \`${installed.source}\` with no \`@<ref>\`: it follows the default branch instead of a released tag.`,
                "Re-add at `@review-v<major>.<minor>.<patch>`.",
            );
        } else if (
            options.checkerVersion !== undefined &&
            installed.pinnedRef !== `review-v${options.checkerVersion}`
        ) {
            warn(
                "source-ref-mismatch",
                `${workflowPath} pins \`${installed.pinnedRef}\`, but this checker ran from review v${options.checkerVersion}: the semantics validated here may not be the ones this repo's reviews run.`,
                `Re-run the checker from a checkout of \`${installed.pinnedRef}\`.`,
            );
        }
        if (installed.observabilityActive) {
            warn(
                "observability-active",
                "The `observability:` block is live, which hard-requires GH_AW_OTEL_SENTRY_ENDPOINT and GH_AW_OTEL_SENTRY_AUTHORIZATION: a missing secret kills the agent job at startup rather than skipping trace export.",
                "Confirm both secrets exist, or comment the block out as a local edit and recompile.",
            );
        }
        if (
            installed.maxAiCredits !== undefined &&
            installed.maxAiCredits <= SHIPPED_MAX_AI_CREDITS
        ) {
            warn(
                "max-ai-credits-default",
                `max-ai-credits is ${installed.maxAiCredits}: runs that route to tier=high have died at ~1001-1024 metered credits after computing a verdict but before posting it.`,
                "Both known consumers raise it to 2500 (a ceiling, not a spend) in review.md and its REVIEW_MAX_AI_CREDITS mirror.",
            );
        }
    }

    /* --- reviewer routing (config.md) -------------------------------------- */

    const reviewerRouting = readReviewerRouting(fs, at(CONFIG_IMPORT_PATH));
    if (reviewerRouting.present) {
        if (!reviewerRouting.definesAddReviewer) {
            error(
                "config-missing-add-reviewer",
                `${CONFIG_IMPORT_PATH} defines no \`safe-outputs.add-reviewer\`, which is the one thing it exists to carry.`,
            );
        } else if (reviewerRouting.allowedTeamReviewers.length === 0) {
            error(
                "config-empty-team-allowlist",
                `${CONFIG_IMPORT_PATH} names no \`allowed-team-reviewers\`, so every reviewer request is dropped by the safe output.`,
            );
        }
        if (
            reviewerRouting.definesAddReviewer &&
            !reviewerRouting.hasGithubToken
        ) {
            warn(
                "config-no-bot-token",
                `${CONFIG_IMPORT_PATH}'s add-reviewer names no \`github-token:\`; the default GITHUB_TOKEN cannot request an organization team as a reviewer.`,
                "Set `github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}`.",
            );
        }
    }

    /* --- .gitattributes ---------------------------------------------------- */

    const generatedPatterns = fs.existsSync(at(GITATTRIBUTES_PATH))
        ? parseGitattributesGenerated(
              fs.readFileSync(at(GITATTRIBUTES_PATH), "utf8"),
          )
        : [];
    if (!isGenerated(lockPath, generatedPatterns)) {
        warn(
            "lock-not-marked-generated",
            `${lockPath} is not marked \`linguist-generated\` in ${GITATTRIBUTES_PATH}, so the reviewer line-reviews its own compiled output.`,
            `Add \`.github/workflows/*.lock.yml linguist-generated=true merge=ours\`.`,
        );
    }

    /* --- leftover scaffolding ---------------------------------------------- */

    const scaffolding = COPILOT_SCAFFOLDING.filter((path) =>
        fs.existsSync(at(path)),
    );
    if (scaffolding.length > 0) {
        warn(
            "copilot-scaffolding-present",
            `\`gh aw\` init scaffolding is still present: ${scaffolding.join(
                ", ",
            )}.`,
            "Both known consumers removed it; keep it only if this repo uses Copilot Agent.",
        );
    }

    /* --- routing over the reviewer's own config ---------------------------- */

    const selfPaths = [
        ROUTING_CONFIG_PATH,
        CONFIG_IMPORT_PATH,
        ...REQUIRED_RUNTIME_IMPORTS,
        workflowPath,
    ];
    const selfRouting = route(
        {files: selfPaths.map((path) => ({path, status: "modified" as const}))},
        {generatedPatterns, lensRules, riskRules},
    );
    const configFileTiers: Record<string, RiskTier> = {};
    for (const path of selfPaths) {
        configFileTiers[path] = selfRouting.perFileTier[path];
    }
    const underTiered = selfPaths.filter(
        (path) => configFileTiers[path] !== "high",
    );
    if (routingPresent && underTiered.length > 0) {
        warn(
            "reviewer-config-not-high",
            `These files steer the reviewer but do not route to tier=high: ${underTiered
                .map((path) => `${path} (${configFileTiers[path]})`)
                .join(
                    ", ",
                )}. A PR editing them would be reviewed at a lower budget than the reviewer it rewrites.`,
            "Add `.github/aw/review/** tier=high` and `.github/workflows/*.md tier=high` to ROUTING.",
        );
    }

    /* --- tier preview ------------------------------------------------------ */

    let tierPreview: TierPreview | undefined;
    if (options.files !== undefined && options.files.length > 0) {
        const files: ChangedFile[] = options.files.map((path) => ({
            path,
            status: "modified",
        }));
        const result: RoutingResult = route(
            {files},
            {generatedPatterns, lensRules, riskRules},
        );
        const counts = emptyTierRecord(() => 0);
        const samples = emptyTierRecord<string[]>(() => []);
        let generated = 0;
        const unmatched: string[] = [];
        for (const file of result.perFile) {
            if (file.classification === "generated") {
                generated++;
                continue;
            }
            counts[file.tier]++;
            if (samples[file.tier].length < SAMPLE_LIMIT) {
                samples[file.tier].push(file.path);
            }
            if (
                !riskRules.some((rule) => matchesGlob(file.path, rule.pattern))
            ) {
                unmatched.push(file.path);
            }
        }
        // A pattern nothing matches is the ROUTING analogue of an inert lens
        // payload: it parses, it routes nothing, and only the file list can
        // reveal it. Deliberately dead patterns exist (a rule written ahead of
        // the directory it guards), hence a warning rather than an error.
        const deadPatterns = [
            ...new Set(
                [...riskRules, ...lensRules]
                    .map((rule) => rule.pattern)
                    .filter(
                        (pattern) =>
                            !options.files?.some((path) =>
                                matchesGlob(path, pattern),
                            ),
                    ),
            ),
        ];

        tierPreview = {
            fileCount: files.length,
            generated,
            counts,
            samples,
            unmatched,
            deadPatterns,
            lensesToSpawn: result.lensesToSpawn,
            highestTier: result.runBudget.tier,
        };
        if (deadPatterns.length > 0) {
            warn(
                "routing-pattern-matches-nothing",
                `${deadPatterns.length} ROUTING pattern(s) match none of the ${
                    files.length
                } supplied paths, so they route nothing: ${deadPatterns.join(
                    ", ",
                )}`,
                "Check for a typo or wrong glob dialect (a pattern with no `/` matches the basename in any directory; prefix `/` to anchor to the repo root), or confirm the rule guards a path this repo does not have yet.",
            );
        }
        if (unmatched.length > 0) {
            warn(
                "files-without-tier-rule",
                `${unmatched.length} of ${
                    files.length
                } tracked files match no \`tier=\` rule and fall to the router's default tier (low): ${unmatched
                    .slice(0, SAMPLE_LIMIT)
                    .join(", ")}${
                    unmatched.length > SAMPLE_LIMIT ? ", …" : ""
                }`,
                "Confirm `low` is the tier you want for these, or add rules.",
            );
        }
    }

    /* --- single-path explanation ------------------------------------------ */

    let explanation: PathExplanation | undefined;
    if (options.explainPath !== undefined) {
        const path = options.explainPath;
        const result = route(
            {files: [{path, status: "modified"}]},
            {generatedPatterns, lensRules, riskRules},
        );
        const decision = result.perFile[0];
        explanation = {
            path,
            generated: decision.classification === "generated",
            tier: decision.tier,
            tierPending: decision.tierPending,
            matchingTierRules: riskRules.filter((rule) =>
                matchesGlob(path, rule.pattern),
            ),
            lenses: decision.lenses,
        };
    }

    return {
        repoRoot,
        issues,
        routing: {
            present: routingPresent,
            enabledReviewers: routingConfig?.enabledReviewers ?? [],
            reReviewMode: routingConfig?.reReviewMode ?? DEFAULT_RE_REVIEW_MODE,
            tierRules: riskRules.length,
            lensRules: lensRules.length,
        },
        installedWorkflow: installed,
        reviewerRouting,
        configFileTiers,
        tierPreview,
        explanation,
    };
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/** Human-readable report. Errors first, then warnings, then the summary. */
export const renderReport = (report: ConsumerConfigReport): string => {
    const lines: string[] = [];
    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );

    lines.push(`Reviewer config check: ${report.repoRoot}`);
    lines.push("");

    const section = (title: string, issues: ConfigIssue[]): void => {
        if (issues.length === 0) {
            return;
        }
        lines.push(`${title} (${issues.length})`);
        for (const issue of issues) {
            lines.push(`  [${issue.code}] ${issue.message}`);
            if (issue.fix !== undefined) {
                lines.push(`      fix: ${issue.fix}`);
            }
        }
        lines.push("");
    };
    section("ERRORS", errors);
    section("WARNINGS", warnings);

    const {routing, installedWorkflow: wf} = report;
    lines.push("Install");
    lines.push(
        `  source            ${wf.source ?? "(none)"}${
            wf.present ? "" : "  [workflow not installed]"
        }`,
    );
    lines.push(`  lock              ${wf.lockPresent ? "present" : "MISSING"}`);
    lines.push(`  max-ai-credits    ${wf.maxAiCredits ?? "(shipped default)"}`);
    lines.push(
        `  observability     ${wf.observabilityActive ? "active" : "disabled"}`,
    );
    lines.push(
        `  reviewer teams    ${
            report.reviewerRouting.allowedTeamReviewers.join(", ") || "(none)"
        }`,
    );
    lines.push("");
    lines.push("ROUTING");
    lines.push(`  present           ${routing.present ? "yes" : "NO"}`);
    lines.push(
        `  tier rules        ${routing.tierRules}    lens rules ${routing.lensRules}`,
    );
    lines.push(
        `  enabled reviewers ${
            routing.enabledReviewers.join(", ") || "(none)"
        }`,
    );
    lines.push(`  re-review         ${routing.reReviewMode}`);

    if (report.tierPreview !== undefined) {
        const preview = report.tierPreview;
        lines.push("");
        lines.push(
            `Tier preview over ${preview.fileCount} tracked files (${preview.generated} generated)`,
        );
        for (const tier of RISK_TIERS) {
            const count = preview.counts[tier];
            const sample = preview.samples[tier].join(", ");
            lines.push(
                `  ${tier.padEnd(8)} ${String(count).padStart(5)}${
                    sample === "" ? "" : `   e.g. ${sample}`
                }`,
            );
        }
        if (preview.deadPatterns.length > 0) {
            lines.push(
                `  dead patterns (match nothing): ${preview.deadPatterns.join(
                    ", ",
                )}`,
            );
        }
        lines.push(
            `  lenses on a whole-repo change: ${
                preview.lensesToSpawn.join(", ") || "(none)"
            }`,
        );
    }

    if (report.explanation !== undefined) {
        const explanation = report.explanation;
        lines.push("");
        lines.push(`Explanation: ${explanation.path}`);
        lines.push(
            `  tier    ${explanation.tier}${
                explanation.tierPending ? " (pending: direction-dependent)" : ""
            }${explanation.generated ? " (generated)" : ""}`,
        );
        lines.push(`  lenses  ${explanation.lenses.join(", ") || "(none)"}`);
        if (explanation.matchingTierRules.length === 0) {
            lines.push("  rules   (none matched; router default tier)");
        } else {
            lines.push("  rules   (last one wins)");
            for (const rule of explanation.matchingTierRules) {
                lines.push(
                    `            ${rule.pattern}  tier=${rule.tier}${
                        rule.diffDirectionDependent
                            ? " direction-dependent"
                            : ""
                    }`,
                );
            }
        }
    }

    lines.push("");
    lines.push(
        errors.length === 0
            ? `PASS with ${warnings.length} warning(s).`
            : `FAIL: ${errors.length} error(s), ${warnings.length} warning(s).`,
    );
    return `${lines.join("\n")}\n`;
};

/* -------------------------------------------------------------------------- */
/* CLI                                                                       */
/* -------------------------------------------------------------------------- */

/** Parse `--flag value` arguments. Unknown flags are an error, not ignored. */
export const parseArgs = (
    argv: readonly string[],
): {
    repoRoot?: string;
    filesFrom?: string;
    explainPath?: string;
    workflowPath?: string;
    json: boolean;
    strict: boolean;
} => {
    const out = {json: false, strict: false} as {
        repoRoot?: string;
        filesFrom?: string;
        explainPath?: string;
        workflowPath?: string;
        json: boolean;
        strict: boolean;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--repo":
                out.repoRoot = argv[++i];
                break;
            case "--files-from":
                out.filesFrom = argv[++i];
                break;
            case "--explain":
                out.explainPath = argv[++i];
                break;
            case "--workflow":
                out.workflowPath = argv[++i];
                break;
            case "--json":
                out.json = true;
                break;
            case "--strict":
                out.strict = true;
                break;
            default:
                throw new Error(`unknown argument: ${arg}`);
        }
    }
    return out;
};

const main = (): void => {
    /* eslint-disable-next-line no-undef */
    const nodeFs = require("node:fs") as FsLike & {
        readFileSync: (p: string | number, enc: "utf8") => string;
    };
    const args = parseArgs(process.argv.slice(2));

    const files =
        args.filesFrom === undefined
            ? undefined
            : nodeFs
                  .readFileSync(
                      args.filesFrom === "-" ? 0 : args.filesFrom,
                      "utf8",
                  )
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "");

    // The version this checker ships with, so a consumer pinned elsewhere is
    // told the semantics validated here are not the ones its reviews run.
    let checkerVersion: string | undefined;
    try {
        checkerVersion = JSON.parse(
            nodeFs.readFileSync(`${__dirname}/../package.json`, "utf8"),
        ).version;
    } catch {
        checkerVersion = undefined;
    }

    const report = checkConsumerConfig(nodeFs, {
        repoRoot: args.repoRoot,
        files,
        explainPath: args.explainPath,
        workflowPath: args.workflowPath,
        checkerVersion,
    });

    process.stdout.write(
        args.json
            ? `${JSON.stringify(report, null, 2)}\n`
            : renderReport(report),
    );

    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );
    if (errors.length > 0 || (args.strict && warnings.length > 0)) {
        process.exitCode = 1;
    }
};

// Run only when invoked directly, never on import (tests).
if (typeof require !== "undefined" && require.main === module) {
    main();
}
