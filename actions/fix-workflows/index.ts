/**
 * Validates and auto-fixes GitHub Actions workflow and action YAML files.
 *
 * Rules enforced:
 * 1. Every `actions/checkout` step must be immediately followed by a
 *    specified setup action step (default: Khan/actions@secure-network-v1).
 * 2. When turned on with `check-runs-on: true`, every `runs-on:` value must
 *    exactly match one of the values in the `allowed-runs-on` list, or
 *    DEFAULT_ALLOWED_RUNS_ON when it's empty (see parseAllowedRunsOn).
 *
 * A setup-step violation is fixed automatically. A `runs-on` violation is
 * only reported: with an exact-match list there is no single right
 * replacement to write.
 * Comments are preserved via the yaml package's document API.
 * Run oxfmt after this script to normalize formatting.
 *
 * Individual jobs, `runs-on:` lines, or checkout steps can opt out of a fix
 * with an inline `fix-workflows-ignore` comment — see IGNORE_DIRECTIVE_RE.
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

/**
 * The allowlist when the caller gives none: the ephemeral-runner toggle that
 * fix-workflows required (as a regex) before v4.
 *
 * This lives here rather than as the input's default in action.yml because
 * GitHub would evaluate the `${{ … }}` in a default before the action sees it.
 */
export const DEFAULT_ALLOWED_RUNS_ON: readonly string[] = [
    "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}",
];

// ---------------------------------------------------------------------------
// Ignore directives
// ---------------------------------------------------------------------------

/** The fixes an ignore directive can suppress. */
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
 * Return true if the runs-on fix is suppressed for `job` by an ignore
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

/**
 * Parse the `allowed-runs-on` input: a YAML list of exact `runs-on` values,
 * usually written as a block scalar so each entry reads like the `runs-on` it
 * matches. (An input can't be a real sequence; GitHub only passes strings.)
 * An empty input or an empty list returns [], which fixWorkflows treats as
 * DEFAULT_ALLOWED_RUNS_ON.
 *
 * GitHub evaluates any `${{ … }}` in a `with:` value before the action runs,
 * so this sees the list after evaluation. A caller lists an expression by
 * escaping its opener (`${{ '${{' }} vars.X … }}`) or by passing a variable
 * whose value holds the expression text, which GitHub doesn't evaluate again.
 */
export function parseAllowedRunsOn(text: string | undefined): string[] {
    if (!text?.trim()) {
        return [];
    }
    const usage =
        "allowed-runs-on must be a YAML list of runs-on values, e.g. " +
        "'- ubuntu-latest' on each line of a block scalar";
    let value: unknown;
    try {
        value = parse(text);
    } catch (err: any) {
        throw new Error(`${usage}: ${err.message}`);
    }
    if (value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`${usage}; got ${JSON.stringify(value)}`);
    }
    for (const item of value) {
        if (typeof item !== "string" || item === "") {
            throw new Error(
                `${usage}; ${JSON.stringify(item)} is not a runs-on value`,
            );
        }
    }
    return value;
}

/**
 * The CLI arguments that repeat this run's options, for the "run this
 * locally" hint. Each value is single-quoted for a POSIX shell.
 */
export function cliArgs({
    checkRunsOn: shouldCheckRunsOn = false,
    allowedRunsOn = [],
    setupAction = DEFAULT_SETUP_ACTION,
}: {
    checkRunsOn?: boolean;
    allowedRunsOn?: readonly string[];
    setupAction?: string;
}): string {
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    return [
        ...(shouldCheckRunsOn ? ["--check-runs-on"] : []),
        ...allowedRunsOn.map((value) => `--allowed-runs-on ${quote(value)}`),
        `--setup-action ${quote(setupAction)}`,
    ].join(" ");
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
        `is not in allowed-runs-on. Use one of the allowed values ` +
        `(matched exactly, including spacing):\n${list}\n` +
        `Or add it to allowed-runs-on, or add a ` +
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

type CoreLike = {
    info: (message: string) => void;
    error: (message: string, properties?: AnnotationProperties) => void;
    setFailed: (message: string) => void;
};

export default async function fixWorkflows({
    core,
    checkRunsOn: shouldCheckRunsOn = false,
    allowedRunsOn: allowedRunsOnList = [],
    setupAction = DEFAULT_SETUP_ACTION,
}: {
    core: CoreLike;
    /** Whether to check `runs-on` against the allowlist. */
    checkRunsOn?: boolean;
    /** The allowed `runs-on` values; empty means DEFAULT_ALLOWED_RUNS_ON. */
    allowedRunsOn?: readonly string[];
    setupAction?: string;
}): Promise<void> {
    const allowedRunsOn = new Set(
        allowedRunsOnList.length > 0
            ? allowedRunsOnList
            : DEFAULT_ALLOWED_RUNS_ON,
    );
    const files = getFilesToCheck();
    let fixedCount = 0;

    for (const file of files) {
        if (processFile(file, {setupAction})) {
            fixedCount++;
        }
    }

    // Verify no violations remain by re-parsing.
    const stillBroken: string[] = [];
    let runsOnViolationCount = 0;
    for (const file of files) {
        const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const lineCounter = new LineCounter();
        const doc = parseDocument(content, {lineCounter});

        let broken = false;
        const jobs = doc.get("jobs");
        if (isMap(jobs)) {
            for (const item of jobs.items) {
                if (
                    isMap(item.value) &&
                    checkJob(item.value as YAMLMap, {setupAction})
                ) {
                    broken = true;
                    break;
                }
            }
        }
        const violations = shouldCheckRunsOn
            ? findRunsOnViolations(doc, allowedRunsOn, lineCounter)
            : [];
        for (const violation of violations) {
            core.error(runsOnViolationMessage(violation, allowedRunsOn), {
                file,
                startLine: violation.line,
            });
            runsOnViolationCount++;
        }
        if (broken) {
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
            `${runsOnViolationCount} runs-on value(s) are not in allowed-runs-on; see the errors above.`,
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
