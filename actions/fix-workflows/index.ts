/**
 * Validates and auto-fixes GitHub Actions workflow and action YAML files.
 *
 * Rules enforced:
 * 1. Every `actions/checkout` step must be immediately followed by a
 *    specified setup action step (default: Khan/actions@secure-network-v1).
 * 2. When turned on with `check-runs-on: true`, every `runs-on:` value must
 *    exactly match one of the `allowed-runs-on` values in the calling repo's
 *    config file, or DEFAULT_ALLOWED_RUNS_ON when it lists none (see
 *    readConfig).
 *
 * A setup-step violation is fixed automatically. A `runs-on` violation is
 * only reported: with an exact-match list there is no single right
 * replacement to write.
 * Comments are preserved via the yaml package's document API.
 * Run oxfmt after this script to normalize formatting.
 *
 * Individual jobs, `runs-on:` lines, or checkout steps can opt out of a fix
 * or check with an inline `fix-workflows-ignore` comment — see
 * IGNORE_DIRECTIVE_RE.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
    isMap,
    isSeq,
    LineCounter,
    parse,
    parseDocument,
    type Document,
    type Node,
    type YAMLMap,
    type YAMLSeq,
} from "yaml";

export const DEFAULT_SETUP_ACTION = "Khan/actions@secure-network-v1";

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();

const YAML_WRITE_OPTIONS = {indent: 4, lineWidth: 0} as const;

/** Where the calling repo's config lives, relative to the repo root. */
export const DEFAULT_CONFIG_FILE = ".github/fix-workflows.yml";

/**
 * The allowlist when the config lists none: the `ubuntu-latest` form of the
 * ephemeral-runner toggle. The pre-v4 regex accepted that toggle with any
 * runner name (`'ubuntu-latest-l'`, `'ubuntu-26.04'`, ...); those forms now
 * have to be listed in the config.
 */
export const DEFAULT_ALLOWED_RUNS_ON: readonly string[] = [
    "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}",
];

// ---------------------------------------------------------------------------
// Ignore directives
// ---------------------------------------------------------------------------

/** The fixes and checks an ignore directive can suppress. */
export type IgnoreRule = "runs-on" | "setup";

const ALL_IGNORE_RULES: readonly IgnoreRule[] = ["runs-on", "setup"];

/**
 * Matches an ignore directive inside a single line of a YAML comment. The
 * optional list after the `:` names which rules to skip; when absent, every
 * rule is skipped for the annotated node. `lintignore` is accepted as an
 * alias for `fix-workflows-ignore`. Examples:
 *
 *   # fix-workflows-ignore
 *   # fix-workflows-ignore: runs-on
 *   # fix-workflows-ignore: runs-on, setup
 *   # lintignore
 */
const IGNORE_DIRECTIVE_RE =
    /(?:fix-workflows-ignore|lintignore)(?:\s*[:=]\s*([a-z0-9,\s_-]+))?/i;

/** Map a rule token from a directive to its canonical IgnoreRule, or null. */
function normalizeRule(token: string): IgnoreRule | null {
    switch (token.trim().toLowerCase()) {
        case "runs-on":
        case "runson":
        case "runs_on":
            return "runs-on";
        case "setup":
        case "secure-network":
        case "checkout":
            return "setup";
        default:
            return null;
    }
}

/**
 * Parse a single comment line for an ignore directive. Returns the set of
 * rules it suppresses, or null when the line contains no directive. An
 * unscoped directive (or one that names only unrecognized rules) suppresses
 * every rule.
 */
function parseDirectiveLine(line: string): Set<IgnoreRule> | null {
    const match = line.match(IGNORE_DIRECTIVE_RE);
    if (!match) {
        return null;
    }
    const spec = match[1]?.trim();
    if (!spec) {
        return new Set(ALL_IGNORE_RULES);
    }
    const rules = new Set<IgnoreRule>();
    for (const token of spec.split(/[,\s]+/)) {
        const rule = normalizeRule(token);
        if (rule) {
            rules.add(rule);
        }
    }
    // A directive that names only unrecognized rules is treated as unscoped
    // rather than silently doing nothing — the author clearly wants to skip.
    return rules.size > 0 ? rules : new Set(ALL_IGNORE_RULES);
}

/**
 * Collect the ignore rules requested by the `comment` and `commentBefore`
 * annotations on any of the given nodes. `commentBefore` may span multiple
 * lines, so each line is inspected. Returns null when no directive is found.
 */
function directiveFrom(
    ...nodes: Array<Node | null | undefined>
): Set<IgnoreRule> | null {
    const merged = new Set<IgnoreRule>();
    let found = false;
    for (const node of nodes) {
        if (!node) {
            continue;
        }
        for (const raw of [node.comment, node.commentBefore]) {
            if (typeof raw !== "string") {
                continue;
            }
            for (const line of raw.split("\n")) {
                const rules = parseDirectiveLine(line);
                if (rules) {
                    found = true;
                    for (const rule of rules) {
                        merged.add(rule);
                    }
                }
            }
        }
    }
    return found ? merged : null;
}

/** Return the key and value nodes of `map`'s pair whose key is `keyName`. */
function pairNodes(map: YAMLMap, keyName: string): Node[] {
    const nodes: Node[] = [];
    for (const item of map.items) {
        const pair = item as {key?: Node; value?: Node};
        if ((pair.key as any)?.value === keyName) {
            if (pair.key) {
                nodes.push(pair.key);
            }
            if (pair.value) {
                nodes.push(pair.value);
            }
        }
    }
    return nodes;
}

/**
 * Return true if the runs-on check is suppressed for `job` by an ignore
 * directive on the `runs-on:` line (trailing or immediately above it) or on
 * the job's leading comment.
 */
export function runsOnIgnored(job: YAMLMap): boolean {
    return (
        directiveFrom(job, ...pairNodes(job, "runs-on"))?.has("runs-on") ??
        false
    );
}

/**
 * Return true if the setup-step fix is suppressed for a checkout `step` by an
 * ignore directive on the step (its leading comment) or on its `uses:` line.
 */
export function stepIgnoresSetup(step: YAMLMap): boolean {
    return (
        directiveFrom(step, ...pairNodes(step, "uses"))?.has("setup") ?? false
    );
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Workflow files this action must not touch because a generator owns them: the
 * fix would be overwritten on the next `gh aw compile`, and worse, a maintainer
 * who follows our own "this file needs updating" hint desyncs the committed file
 * from its compiler.
 *
 * `*.lock.yml` is the compiled agentic workflow; `agentics-maintenance.yml` is
 * gh-aw's scheduled housekeeping workflow, which is regenerated unconditionally
 * and (unhelpfully) is not named `*.lock.yml`.
 *
 * Matching by name rather than by content is deliberate, and the cheap
 * content check is not the upgrade it looks like. Both files gh-aw emits do
 * carry a `DO NOT EDIT.` marker in their first line, so the *fixer* could
 * sniff for it and stop needing this list. The oxfmt step cannot: it selects
 * files by glob, and a glob cannot read a header. Teaching only the fixer to
 * sniff would put the two back out of step -- a marked-but-unlisted file would
 * be skipped by the fixer and still reformatted by the formatter, which is
 * exactly the bug this list exists to close. A content rule has to arrive at
 * both sites at once (the formatter taking an explicit file list computed here
 * instead of a glob), so it is left for when a third generated workflow makes
 * that refactor worth it.
 */
export const GENERATED_WORKFLOWS = {
    suffixes: [".lock.yml"],
    names: ["agentics-maintenance.yml"],
};

/** Whether a `.github/workflows` entry is generator-owned (see above). */
export function isGeneratedWorkflow(name: string): boolean {
    return (
        GENERATED_WORKFLOWS.suffixes.some((suffix) => name.endsWith(suffix)) ||
        GENERATED_WORKFLOWS.names.includes(name)
    );
}

/**
 * `GENERATED_WORKFLOWS` as negated oxfmt globs, for the formatting step that
 * runs after the fixer.
 *
 * The formatter selects files by glob rather than by `isGeneratedWorkflow`, so
 * the skip set has to be expressible as globs too; deriving them here keeps
 * cli.ts from carrying a second copy of the set. action.yml still spells them
 * out (a composite action's bash step cannot import this module), and
 * generated-workflows.test.ts asserts its literals against this function so
 * that copy cannot drift.
 *
 * The `**` mirrors the recursive positive glob both call sites pass. It also
 * matches files directly in `.github/workflows`, so one pattern covers both
 * depths (verified against the pinned oxfmt@0.44.0).
 */
export function generatedWorkflowSkipGlobs(): string[] {
    return [
        ...GENERATED_WORKFLOWS.suffixes.map(
            (suffix) => `!.github/workflows/**/*${suffix}`,
        ),
        ...GENERATED_WORKFLOWS.names.map(
            (name) => `!.github/workflows/**/${name}`,
        ),
    ];
}

function getFilesToCheck(): string[] {
    const files: string[] = [];

    const workflowDir = path.join(repoRoot, ".github", "workflows");
    for (const entry of fs.readdirSync(workflowDir, {withFileTypes: true})) {
        if (
            entry.isFile() &&
            (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) &&
            !isGeneratedWorkflow(entry.name)
        ) {
            files.push(path.join(".github", "workflows", entry.name));
        }
    }

    return files;
}

// ---------------------------------------------------------------------------
// Detection and auto-fix via yaml document API
// ---------------------------------------------------------------------------

/**
 * Iterate steps in reverse and inserts a setup step after every checkout
 * step that isn't already followed by one. Also ensures every existing setup
 * step has `timeout-minutes: 5`. Returns true if any changes were made.
 */
export function fixSteps(
    doc: Document,
    steps: YAMLSeq,
    setupAction: string = DEFAULT_SETUP_ACTION,
): boolean {
    let changed = false;
    // Strip ./ prefix for substring detection so both "./foo" and "foo" match.
    const normalizedSetupAction = setupAction.replace(/^\.\//, "");
    const isPath = setupAction.startsWith("./") || setupAction.startsWith("/");

    // Iterate in reverse so insertions don't shift the indices we still need.
    for (let i = steps.items.length - 1; i >= 0; i--) {
        const step = steps.items[i];
        if (!isMap(step)) {
            continue;
        }

        const uses = step.get("uses");

        // Ensure existing setup steps have timeout-minutes: 5.
        if (typeof uses === "string" && uses.includes(normalizedSetupAction)) {
            const timeout = step.get("timeout-minutes");
            if (timeout === undefined || timeout === null) {
                (step as any).set("timeout-minutes", 5);
                changed = true;
            }
            continue;
        }

        if (typeof uses !== "string" || !uses.startsWith("actions/checkout")) {
            continue;
        }

        // Skip checkouts that opt out via an inline ignore directive.
        if (stepIgnoresSetup(step)) {
            continue;
        }

        const nextStep = steps.items[i + 1];
        const nextUses = isMap(nextStep)
            ? String(nextStep.get("uses") ?? "")
            : "";
        if (nextUses.includes(normalizedSetupAction)) {
            continue;
        }

        const setupStep = doc.createNode({
            name: isPath ? "Setup" : "Secure Network",
            uses: setupAction,
            "timeout-minutes": 5,
        });
        // If the checkout step has an `if:` condition, the setup step must
        // inherit it so it doesn't run when the checkout was skipped.
        const checkoutIf = step.get("if");
        if (checkoutIf !== undefined && checkoutIf !== null) {
            (setupStep as any).set("if", checkoutIf);
        }
        steps.items.splice(i + 1, 0, setupStep);
        changed = true;
    }
    return changed;
}

/**
 * Return true if the steps sequence contains any checkout step that is not
 * immediately followed by a setup step, or any setup step that is missing
 * `timeout-minutes: 5` (i.e. a violation remains).
 */
export function checkSteps(
    steps: YAMLSeq,
    setupAction: string = DEFAULT_SETUP_ACTION,
): boolean {
    const normalizedSetupAction = setupAction.replace(/^\.\//, "");
    for (let i = 0; i < steps.items.length; i++) {
        const step = steps.items[i];
        if (!isMap(step)) {
            continue;
        }
        const uses = step.get("uses");
        if (typeof uses !== "string") {
            continue;
        }
        if (uses.includes(normalizedSetupAction)) {
            const timeout = step.get("timeout-minutes");
            if (timeout === undefined || timeout === null) {
                return true;
            }
            continue;
        }
        if (!uses.startsWith("actions/checkout")) {
            continue;
        }
        // Skip checkouts that opt out via an inline ignore directive.
        if (stepIgnoresSetup(step)) {
            continue;
        }
        const nextUses = isMap(steps.items[i + 1])
            ? String((steps.items[i + 1] as any).get("uses") ?? "")
            : "";
        if (!nextUses.includes(normalizedSetupAction)) {
            return true;
        }
    }
    return false;
}

/**
 * Return true if the job's runner is exempt from all fixups.
 * macOS runners are GitHub-hosted and don't use our secure network setup.
 */
export function isExemptRunner(job: YAMLMap): boolean {
    const runsOn = job.get("runs-on");
    return typeof runsOn === "string" && runsOn.startsWith("macos-");
}

// ---------------------------------------------------------------------------
// runs-on allowlist
// ---------------------------------------------------------------------------

/** The settings a config file can hold. */
export type Config = {
    /** Exact `runs-on` values; empty means DEFAULT_ALLOWED_RUNS_ON. */
    allowedRunsOn: string[];
};

const CONFIG_KEYS = ["allowed-runs-on"];

/**
 * Parse a config file's text. It's YAML so that each `allowed-runs-on` entry
 * follows the same quoting rules as the workflow `runs-on` it's copied from:
 *
 *   allowed-runs-on:
 *       - ubuntu-latest
 *       - ${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}
 *
 * The list is a file rather than an action input because GitHub evaluates
 * any `${{ … }}` in a `with:` value before the action runs, so an expression
 * passed inline would arrive resolved rather than as text to compare.
 *
 * Unknown keys are rejected so that a misspelled key fails instead of
 * silently falling back to the default list.
 */
export function parseConfig(text: string, filePath: string): Config {
    let value: unknown;
    try {
        value = parse(text);
    } catch (err: any) {
        throw new Error(`${filePath} is not valid YAML: ${err.message}`);
    }
    // An empty or comments-only file parses to null: no settings.
    if (value === null || value === undefined) {
        return {allowedRunsOn: []};
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
            `${filePath} must be a YAML mapping with an allowed-runs-on key`,
        );
    }
    const unknown = Object.keys(value).filter((k) => !CONFIG_KEYS.includes(k));
    if (unknown.length > 0) {
        throw new Error(
            `${filePath} has unknown key(s) ${unknown.join(", ")}; ` +
                `expected ${CONFIG_KEYS.join(", ")}`,
        );
    }
    const list = (value as Record<string, unknown>)["allowed-runs-on"];
    if (list === null || list === undefined) {
        return {allowedRunsOn: []};
    }
    if (!Array.isArray(list)) {
        throw new Error(
            `allowed-runs-on in ${filePath} must be a list of runs-on values`,
        );
    }
    for (const item of list) {
        if (typeof item !== "string" || item === "") {
            throw new Error(
                `allowed-runs-on in ${filePath} must be a list of runs-on ` +
                    `values; ${JSON.stringify(item)} is not one`,
            );
        }
    }
    return {allowedRunsOn: list};
}

/**
 * Read and parse the config at `filePath` (relative to the repo root). A
 * missing file returns null, unless `required` is set, which callers do when
 * the path was given explicitly: naming a file that isn't there is a mistake,
 * not a request for the defaults.
 */
export function readConfig(
    filePath: string,
    {required = false}: {required?: boolean} = {},
): Config | null {
    let text: string;
    try {
        text = fs.readFileSync(path.resolve(repoRoot, filePath), "utf8");
    } catch (err: any) {
        if (err?.code !== "ENOENT") {
            throw err;
        }
        if (required) {
            throw new Error(`The config file ${filePath} does not exist.`);
        }
        return null;
    }
    return parseConfig(text, filePath);
}

/**
 * Return true if the job's `runs-on` value is non-compliant, i.e. a string
 * that isn't exactly one of `allowed`. Non-string values (label arrays,
 * `group:` maps) aren't checked.
 */
export function checkRunsOn(
    job: YAMLMap,
    allowed: ReadonlySet<string>,
): boolean {
    const runsOn = job.get("runs-on");
    if (typeof runsOn !== "string") {
        return false;
    }
    if (isExemptRunner(job)) {
        return false;
    }
    // An explicit ignore directive opts the job out of the runs-on check.
    if (runsOnIgnored(job)) {
        return false;
    }
    return !allowed.has(runsOn);
}

export type RunsOnViolation = {
    jobId: string;
    runsOn: string;
    /** 1-based line of the `runs-on` value, when a LineCounter was given. */
    line?: number | undefined;
};

/**
 * Return every job in `doc` whose `runs-on` isn't on the allowlist. Pass the
 * LineCounter the document was parsed with to get line numbers.
 */
export function findRunsOnViolations(
    doc: Document,
    allowed: ReadonlySet<string>,
    lineCounter?: LineCounter,
): RunsOnViolation[] {
    const violations: RunsOnViolation[] = [];
    const jobs = doc.get("jobs");
    if (!isMap(jobs)) {
        return violations;
    }
    for (const item of jobs.items) {
        const job = item.value;
        if (!isMap(job) || !checkRunsOn(job as YAMLMap, allowed)) {
            continue;
        }
        const valueNode = pairNodes(job as YAMLMap, "runs-on")[1];
        const offset = valueNode?.range?.[0];
        violations.push({
            jobId: String((item.key as any)?.value ?? item.key),
            runsOn: job.get("runs-on") as string,
            line:
                lineCounter && offset !== undefined
                    ? lineCounter.linePos(offset).line
                    : undefined,
        });
    }
    return violations;
}

/** The annotation text for a `runs-on` value that isn't on the allowlist. */
export function runsOnViolationMessage(
    violation: RunsOnViolation,
    allowed: ReadonlySet<string>,
): string {
    const list = [...allowed].map((value) => `  ${value}`).join("\n");
    return (
        `Job '${violation.jobId}' has runs-on '${violation.runsOn}', which ` +
        `is not an allowed value. Use one of these (matched exactly, ` +
        `including spacing):\n${list}\n` +
        `Or add it to allowed-runs-on in the config file, or add a ` +
        `'# fix-workflows-ignore: runs-on' comment to the runs-on line.`
    );
}

type JobOptions = {
    setupAction?: string;
};

/**
 * Apply all fixes to a single job map. Skips exempt runners entirely.
 * Returns true if any changes were made.
 */
export function processJob(
    doc: Document,
    job: YAMLMap,
    {setupAction = DEFAULT_SETUP_ACTION}: JobOptions = {},
): boolean {
    if (isExemptRunner(job)) {
        return false;
    }
    let changed = false;
    const steps = (job as any).get("steps");
    if (isSeq(steps)) {
        changed = fixSteps(doc, steps, setupAction) || changed;
    }
    return changed;
}

/**
 * Return true if a single job map has any remaining setup-step violations.
 * Always returns false for exempt runners. `runs-on` is checked separately,
 * by findRunsOnViolations.
 */
export function checkJob(
    job: YAMLMap,
    {setupAction = DEFAULT_SETUP_ACTION}: JobOptions = {},
): boolean {
    if (isExemptRunner(job)) {
        return false;
    }
    const steps = (job as any).get("steps");
    return isSeq(steps) && checkSteps(steps, setupAction);
}

/**
 * Parse the file, fix any violations, and write it back if changed.
 * Returns true if the file was modified.
 */
export function processFile(
    filePath: string,
    options: JobOptions = {},
): boolean {
    const absPath = path.join(repoRoot, filePath);
    const content = fs.readFileSync(absPath, "utf8");
    const doc = parseDocument(content);
    let changed = false;

    const jobs = doc.get("jobs");
    if (isMap(jobs)) {
        for (const item of jobs.items) {
            if (!isMap(item.value)) {
                continue;
            }
            changed =
                processJob(doc, item.value as YAMLMap, options) || changed;
        }
    }

    if (changed) {
        console.log(`  Fixed ${filePath}`); // eslint-disable-line no-console
        fs.writeFileSync(absPath, doc.toString(YAML_WRITE_OPTIONS), "utf8");
    }
    return changed;
}

// ---------------------------------------------------------------------------
// Main (exported for use as a GitHub Action)
// ---------------------------------------------------------------------------

export type AnnotationProperties = {
    file?: string;
    startLine?: number | undefined;
};

export type Options = {
    /** Whether to check `runs-on` against the allowlist. */
    checkRunsOn?: boolean;
    /** The config file; empty means DEFAULT_CONFIG_FILE, if it exists. */
    configFile?: string;
    setupAction?: string;
};

/**
 * Parse the CLI's arguments (without the leading `node` and script path).
 * `--fix-runs-on` is the pre-v4 name for `--check-runs-on`. An unknown
 * argument or a flag missing its value throws rather than quietly falling
 * back to the default.
 */
export function parseCliArgs(args: readonly string[]): Required<Options> {
    const options: Required<Options> = {
        checkRunsOn: false,
        configFile: "",
        setupAction: DEFAULT_SETUP_ACTION,
    };
    const valueOf = (i: number): string => {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${args[i]} needs a value`);
        }
        return value;
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--check-runs-on" || arg === "--fix-runs-on") {
            options.checkRunsOn = true;
        } else if (arg === "--config-file") {
            options.configFile = valueOf(i++);
        } else if (arg === "--setup-action") {
            options.setupAction = valueOf(i++);
        } else {
            // Every token reaching here is meant as a flag (values are
            // consumed above), so this is a typo or `--flag=value`.
            throw new Error(`Unknown argument ${arg}`);
        }
    }
    return options;
}

type CoreLike = {
    info: (message: string) => void;
    warning: (message: string) => void;
    error: (message: string, properties?: AnnotationProperties) => void;
    setFailed: (message: string) => void;
};

export default async function fixWorkflows({
    core,
    checkRunsOn: shouldCheckRunsOn = false,
    configFile = "",
    setupAction = DEFAULT_SETUP_ACTION,
}: Options & {core: CoreLike}): Promise<void> {
    const configPath = configFile || DEFAULT_CONFIG_FILE;
    let allowedRunsOn = new Set(DEFAULT_ALLOWED_RUNS_ON);
    if (shouldCheckRunsOn) {
        // Read the config before touching any file, so a broken one fails
        // the run without leaving half-applied fixes behind.
        const config = readConfig(configPath, {required: configFile !== ""});
        if (config && config.allowedRunsOn.length > 0) {
            allowedRunsOn = new Set(config.allowedRunsOn);
        } else {
            const why = config
                ? `${configPath} lists no allowed-runs-on`
                : `No ${configPath}`;
            core.info(
                `${why}; allowing only the default runs-on: ` +
                    DEFAULT_ALLOWED_RUNS_ON.join(", "),
            );
        }
    } else if (fs.existsSync(path.resolve(repoRoot, configPath))) {
        // The config only matters to the check, so with the check off it is
        // neither validated nor allowed to fail the run.
        core.warning(
            `${configPath} exists, but check-runs-on is off, so runs-on ` +
                `values aren't checked against it.`,
        );
    }
    const files = getFilesToCheck();
    let fixedCount = 0;
    let runsOnViolationCount = 0;

    for (const file of files) {
        // Check runs-on before the setup autofix rewrites the file: inserted
        // steps would shift the lines, and GitHub shows annotations against
        // the committed file. The autofix never changes runs-on, so the
        // result is the same either way.
        if (shouldCheckRunsOn) {
            const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
            const lineCounter = new LineCounter();
            const doc = parseDocument(content, {lineCounter});
            for (const violation of findRunsOnViolations(
                doc,
                allowedRunsOn,
                lineCounter,
            )) {
                core.error(runsOnViolationMessage(violation, allowedRunsOn), {
                    file,
                    startLine: violation.line,
                });
                runsOnViolationCount++;
            }
        }
        if (processFile(file, {setupAction})) {
            fixedCount++;
        }
    }

    // Verify no setup-step violations remain by re-parsing.
    const stillBroken: string[] = [];
    for (const file of files) {
        const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const doc = parseDocument(content);
        const jobs = doc.get("jobs");
        if (
            isMap(jobs) &&
            jobs.items.some(
                (item) =>
                    isMap(item.value) &&
                    checkJob(item.value as YAMLMap, {setupAction}),
            )
        ) {
            stillBroken.push(file);
        }
    }

    const failures: string[] = [];
    if (stillBroken.length > 0) {
        failures.push(
            `Could not auto-fix all violations:\n${stillBroken
                .map((f) => `  ${f}`)
                .join("\n")}`,
        );
    }
    if (runsOnViolationCount > 0) {
        failures.push(
            `${runsOnViolationCount} runs-on value(s) are not allowed; see the errors above.`,
        );
    }
    if (failures.length > 0) {
        core.setFailed(failures.join("\n"));
        return;
    }

    if (fixedCount > 0) {
        core.info(`Fixed ${fixedCount} file(s).`);
    } else {
        core.info("No violations found.");
    }
}
