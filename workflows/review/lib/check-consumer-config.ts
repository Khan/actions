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
    ROUTING_CONFIG_PATH,
    route,
    matchesGlob,
    lensPayloadWarnings,
    SPECIALIST_LENSES,
    CORRECTNESS_ALIAS_PATH,
    LENS_PAYLOAD_DIR,
    DEFAULT_RE_REVIEW_MODE,
    REVIEWERS_PATH,
} from "./router";
import type {ChangedFile, RoutingResult} from "./router";
import {
    frontmatterBlock,
    hasKey,
    items,
    list,
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
import {renderReport} from "./check-consumer-config-report";

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

/**
 * gh-aw's scheduled housekeeping workflow (gh-aw v0.83+). Generated like a lock
 * file but NOT named `*.lock.yml`, so the documented marker misses it.
 */
export const MAINTENANCE_WORKFLOW_PATH =
    ".github/workflows/agentics-maintenance.yml";

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
 *
 * FALLBACK ONLY: the CLI reads the live value from this checkout's own
 * `review.md` and passes it as `options.shippedMaxAiCredits`; this constant is
 * used when that read fails, so a release that raises the shipped ceiling does
 * not silently strand the check on a stale number.
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
    /** The `env.REVIEW_MAX_AI_CREDITS` mirror `resolveCreditCap` reads. */
    creditMirror?: number;
    /** True when the `observability:` block is live (not commented out). */
    observabilityActive: boolean;
};

/** What `config.md`'s frontmatter says. */
export type ReviewerRouting = {
    present: boolean;
    definesAddReviewer: boolean;
    /**
     * Whether `allowed-team-reviewers` appears at all, as distinct from
     * appearing and yielding no teams. Absent is a deliberate no-requests
     * install; present-but-empty is a defect.
     */
    allowlistKeyPresent: boolean;
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
export type ConsumerConfigFs = {
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
    /**
     * The `max-ai-credits` the shared workflow ships, read from the checker's
     * own checkout of `workflows/review/review.md` (the CLI does this). Falls
     * back to {@link SHIPPED_MAX_AI_CREDITS} so a release that raises the
     * shipped ceiling cannot leave the check comparing against a stale
     * constant.
     */
    shippedMaxAiCredits?: number;
};

const emptyTierRecord = <T>(make: () => T): Record<RiskTier, T> => ({
    trivial: make(),
    low: make(),
    medium: make(),
    high: make(),
});

const readInstalledWorkflow = (
    fs: ConsumerConfigFs,
    path: string,
): InstalledWorkflow => {
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
    // The env mirror the run budget actually reads (resolveCreditCap in
    // credit-cap.ts): the frontmatter cap is enforced proxy-side and invisible
    // to the agent process, so the two must agree or the router plans at the
    // stale ceiling.
    const mirror = scalar(nested(lines, "env") ?? [], "REVIEW_MAX_AI_CREDITS");

    return {
        present: true,
        lockPresent: false, // filled by the caller (path may be renamed)
        source,
        pinnedRef,
        // Compared through `items()` so a quoted entry (`- ".github/…"`, valid
        // YAML) is not read as a missing import, which would be a false error.
        importsConfig: items(imports).includes(CONFIG_IMPORT_PATH),
        definesAddReviewer:
            nestedPath(lines, ["safe-outputs", "add-reviewer"]) !== undefined,
        maxAiCredits: credits === undefined ? undefined : Number(credits),
        creditMirror: mirror === undefined ? undefined : Number(mirror),
        observabilityActive: hasKey(lines, "observability"),
    };
};

const readReviewerRouting = (
    fs: ConsumerConfigFs,
    path: string,
): ReviewerRouting => {
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
    // `list()` reads both block and flow style, and returns undefined only when
    // the key is absent. That distinction is the whole point here: an absent key
    // is a deliberate "this repo requests no reviewers", while a key that yields
    // nothing is a mistake or a spelling this reader cannot read. Collapsing the
    // two would let a broken allowlist report as a deliberate choice.
    const teams =
        addReviewer === undefined
            ? undefined
            : list(addReviewer, "allowed-team-reviewers");
    return {
        present: true,
        definesAddReviewer: addReviewer !== undefined,
        allowlistKeyPresent: teams !== undefined,
        allowedTeamReviewers: teams ?? [],
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
    fs: ConsumerConfigFs,
    options: CheckOptions = {},
): ConsumerConfigReport => {
    const repoRoot = options.repoRoot ?? ".";
    // `--repo` takes a path to the consumer checkout; an owner/name arg
    // resolves as a relative path and every check would report missing.
    if (repoRoot !== "." && !fs.existsSync(repoRoot)) {
        throw new Error(
            `--repo path does not exist: ${repoRoot} (a path to the consumer checkout, not an owner/name)`,
        );
    }
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
            "Re-review mode is `full` (the default, and the most expensive setting; the parser cannot tell an explicit `re-review full` from an absent line): every push re-runs the whole roster over the whole diff.",
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
                `${workflowPath} carries no \`source:\` field, so the manual bump flow cannot tell which upstream release this install was copied from.`,
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
        const shippedCredits =
            options.shippedMaxAiCredits ?? SHIPPED_MAX_AI_CREDITS;
        if (
            installed.maxAiCredits !== undefined &&
            installed.maxAiCredits <= shippedCredits
        ) {
            warn(
                "max-ai-credits-default",
                `max-ai-credits is ${installed.maxAiCredits}: runs that route to tier=high have died at ~1001-1024 metered credits after computing a verdict but before posting it.`,
                "Both known consumers raise it to 2500 (a ceiling, not a spend) in review.md and its REVIEW_MAX_AI_CREDITS mirror.",
            );
        }
        // The frontmatter cap is enforced by the firewall api-proxy; the run
        // budget reads only the env mirror (resolveCreditCap). A raised cap
        // with a stale or missing mirror still PLANS at the old ceiling: the
        // exact late-and-quiet failure this checker exists to catch.
        if (
            installed.maxAiCredits !== undefined &&
            installed.creditMirror !== installed.maxAiCredits
        ) {
            warn(
                "max-ai-credits-mirror-stale",
                installed.creditMirror === undefined
                    ? `max-ai-credits is ${installed.maxAiCredits} but the frontmatter sets no REVIEW_MAX_AI_CREDITS env mirror; the router reads only the mirror, so runs plan against the shipped default instead of the raised cap.`
                    : `max-ai-credits is ${installed.maxAiCredits} but its REVIEW_MAX_AI_CREDITS env mirror says ${installed.creditMirror}; the router reads only the mirror, so the two must agree.`,
                `Set env.REVIEW_MAX_AI_CREDITS to "${installed.maxAiCredits}" in the same frontmatter (KEEP THE TWO VALUES IN SYNC, per the shipped review.md).`,
            );
        }
    }

    /* --- reviewer routing (config.md) -------------------------------------- */

    // Whether a reviewer request can happen here at all. The router reads ownership
    // from `.github/REVIEWERS` and nowhere else, so without it Step 8 has no owners
    // and no ranked fallback and requests nobody, whatever the allowlist says.
    const ownershipMapPresent = fs.existsSync(at(REVIEWERS_PATH));

    const reviewerRouting = readReviewerRouting(fs, at(CONFIG_IMPORT_PATH));
    if (reviewerRouting.present) {
        if (!reviewerRouting.definesAddReviewer) {
            error(
                "config-missing-add-reviewer",
                `${CONFIG_IMPORT_PATH} defines no \`safe-outputs.add-reviewer\`, which is the one thing it exists to carry.`,
            );
        } else if (reviewerRouting.allowedTeamReviewers.length === 0) {
            // Three cases, and conflating any two of them either fails a working
            // install or blesses a broken one.
            //
            // The key is PRESENT but yields no teams: always an error, whatever
            // `.github/REVIEWERS` says. Someone wrote the field and got nothing
            // out of it — an empty list, or a spelling this reader cannot read.
            // Reporting that as a deliberate choice would be the worst outcome,
            // because it reads as an all-clear over a dropped allowlist.
            //
            // The key is ABSENT: now `.github/REVIEWERS` decides. It is the
            // router's only source of ownership, so without it Step 8 computes
            // nobody to request and the omission is an accurate statement that
            // this repo makes no reviewer requests. With it, ownership exists and
            // nothing is allowed through, so the requests are computed and then
            // silently dropped.
            if (reviewerRouting.allowlistKeyPresent) {
                error(
                    "config-empty-team-allowlist",
                    `${CONFIG_IMPORT_PATH} has an \`allowed-team-reviewers\` key that yields no teams, so every reviewer request is dropped by the safe output.`,
                    "Name the owning team(s) as `- team` lines or `[team]`, or delete the key entirely if this repo should request no reviewers.",
                );
            } else if (ownershipMapPresent) {
                error(
                    "config-empty-team-allowlist",
                    `${CONFIG_IMPORT_PATH} names no \`allowed-team-reviewers\`, but ${REVIEWERS_PATH} gives the router team ownership, so Step 8 computes teams to request and the safe output drops every one.`,
                    `Name the owning team(s), or delete ${REVIEWERS_PATH} if this repo should not request reviewers at all.`,
                );
            } else {
                warn(
                    "reviewer-requests-inert",
                    `${CONFIG_IMPORT_PATH} names no \`allowed-team-reviewers\` and there is no ${REVIEWERS_PATH}, so this repo requests no reviewers. That is a valid configuration; it is reported because it is invisible on the PR.`,
                    `If reviewer requests are wanted, add ${REVIEWERS_PATH} and name the owning team(s) here — either alone is inert.`,
                );
            }
        }
        // Only matters for a request that can actually be made, so a deliberate
        // no-requests install reports one finding rather than two.
        if (
            reviewerRouting.definesAddReviewer &&
            !reviewerRouting.hasGithubToken &&
            (ownershipMapPresent ||
                reviewerRouting.allowedTeamReviewers.length > 0)
        ) {
            warn(
                "config-no-bot-token",
                `${CONFIG_IMPORT_PATH}'s add-reviewer names no \`github-token:\`; the default GITHUB_TOKEN cannot request an organization team as a reviewer.`,
                "Set `github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}`.",
            );
        }
    }

    /* --- .gitattributes ---------------------------------------------------- */

    const generatedRules = fs.existsSync(at(GITATTRIBUTES_PATH))
        ? parseGitattributesGenerated(
              fs.readFileSync(at(GITATTRIBUTES_PATH), "utf8"),
          )
        : [];
    // Guarded on the lock actually existing: a repo with no reviewer installed
    // (or one the errors above just told has no lock) should not additionally
    // be told to mark a nonexistent file as generated — the report reads
    // cause-then-effect, and under --strict the extra warning would flip the
    // exit code.
    if (installed.lockPresent && !isGenerated(lockPath, generatedRules)) {
        warn(
            "lock-not-marked-generated",
            `${lockPath} is not marked \`linguist-generated\` in ${GITATTRIBUTES_PATH}, so the reviewer line-reviews its own compiled output.`,
            `Add \`.github/workflows/*.lock.yml linguist-generated=true merge=ours\`.`,
        );
    }
    // The generated workflow the usual `*.lock.yml` marker misses: `gh aw compile`
    // writes it unconditionally (deleting it does not stick) under a name that does
    // not match, so a repo that followed the documented marker still gets ~600 lines
    // of compiler output line-reviewed. Installs predating gh-aw v0.83 lack the file.
    if (
        fs.existsSync(at(MAINTENANCE_WORKFLOW_PATH)) &&
        !isGenerated(MAINTENANCE_WORKFLOW_PATH, generatedRules)
    ) {
        warn(
            "maintenance-workflow-not-marked-generated",
            `${MAINTENANCE_WORKFLOW_PATH} is \`gh aw compile\` output but is not marked \`linguist-generated\` in ${GITATTRIBUTES_PATH}, so the reviewer line-reviews it. The \`*.lock.yml\` marker does not cover it.`,
            `Add \`${MAINTENANCE_WORKFLOW_PATH} linguist-generated=true merge=ours\`.`,
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
        {generatedRules, lensRules, riskRules},
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
            {generatedRules, lensRules, riskRules},
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
            {generatedRules, lensRules, riskRules},
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

// The text rendering lives in its own module (split by concern, and to keep this
// file inside its max-lines budget). Imported for the CLI below and re-exported so
// existing importers still treat this module as the checker's single entry point.
export {renderReport};

/* -------------------------------------------------------------------------- */
/* CLI                                                                       */
/* -------------------------------------------------------------------------- */

type CliArgs = {
    repoRoot?: string;
    filesFrom?: string;
    explainPath?: string;
    workflowPath?: string;
    json: boolean;
    strict: boolean;
};

/** Parse `--flag value` arguments. Unknown flags are an error, not ignored. */
export const parseArgs = (argv: readonly string[]): CliArgs => {
    const out = {json: false, strict: false} as CliArgs;
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
    const nodeFs = require("node:fs") as ConsumerConfigFs & {
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

    // The ceiling the shared workflow ships, read from this checkout's own
    // review.md so a release that raises it cannot strand the hardcoded
    // fallback constant.
    let shippedMaxAiCredits: number | undefined;
    try {
        const shipped = frontmatterBlock(
            nodeFs.readFileSync(`${__dirname}/../review.md`, "utf8"),
        );
        const raw =
            shipped === undefined
                ? undefined
                : scalar(yamlLines(shipped), "max-ai-credits");
        const parsed = raw === undefined ? NaN : Number(raw);
        shippedMaxAiCredits = Number.isFinite(parsed) ? parsed : undefined;
    } catch {
        shippedMaxAiCredits = undefined;
    }

    const report = checkConsumerConfig(nodeFs, {
        repoRoot: args.repoRoot,
        files,
        explainPath: args.explainPath,
        workflowPath: args.workflowPath,
        checkerVersion,
        shippedMaxAiCredits,
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
