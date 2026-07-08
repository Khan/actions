/**
 * Validates and auto-fixes GitHub Actions workflow and action YAML files.
 *
 * Rules enforced:
 * 1. Every `actions/checkout` step must be immediately followed by a
 *    specified setup action step (default: Khan/actions@secure-network-v1).
 * 2. Optionally, every `runs-on:` value must use the conditional expression:
 *    "${{ vars.USE_GITHUB_RUNNERS == 'true' && '<runner>' || 'ephemeral-runner' }}"
 *
 * When a violation is found it is fixed automatically.
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
    parseDocument,
    type Document,
    type Node,
    type YAMLMap,
    type YAMLSeq,
} from "yaml";

export const DEFAULT_SETUP_ACTION = "Khan/actions@secure-network-v1";

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();

const YAML_WRITE_OPTIONS = {indent: 4, lineWidth: 0} as const;

/** Matches the required conditional runs-on expression (any runner name). */
const VALID_RUNS_ON_RE =
    /vars\.USE_GITHUB_RUNNERS\s*==\s*'true'\s*&&\s*'[^']+'\s*\|\|\s*'ephemeral-runner[\w-]*'\s*\}\}$/;

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

function getFilesToCheck(): string[] {
    const files: string[] = [];

    const workflowDir = path.join(repoRoot, ".github", "workflows");
    for (const entry of fs.readdirSync(workflowDir, {withFileTypes: true})) {
        if (
            entry.isFile() &&
            (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) &&
            !entry.name.endsWith(".lock.yml")
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

/**
 * Return true if the job's `runs-on` value is non-compliant (i.e., it is a
 * plain runner name rather than the required conditional expression).
 */
export function checkRunsOn(job: YAMLMap): boolean {
    const runsOn = job.get("runs-on");
    if (typeof runsOn !== "string") {
        return false;
    }
    if (isExemptRunner(job)) {
        return false;
    }
    // An explicit ignore directive opts the job out of the runs-on fix, so
    // treat it as compliant. This gates fixRunsOn too, which calls checkRunsOn.
    if (runsOnIgnored(job)) {
        return false;
    }
    return !VALID_RUNS_ON_RE.test(runsOn);
}

/**
 * If the job's `runs-on` is a plain runner name, replace it with the
 * required conditional expression. Returns true if changed.
 */
export function fixRunsOn(job: YAMLMap): boolean {
    if (!checkRunsOn(job)) {
        return false;
    }
    const runsOn = job.get("runs-on") as string;
    const newValue = `\${{ vars.USE_GITHUB_RUNNERS == 'true' && '${runsOn}' || 'ephemeral-runner' }}`;
    (job as any).set("runs-on", newValue);
    return true;
}

type JobOptions = {
    shouldFixRunsOn?: boolean;
    setupAction?: string;
};

/**
 * Apply all fixes to a single job map. Skips exempt runners entirely.
 * Returns true if any changes were made.
 */
export function processJob(
    doc: Document,
    job: YAMLMap,
    {
        shouldFixRunsOn = false,
        setupAction = DEFAULT_SETUP_ACTION,
    }: JobOptions = {},
): boolean {
    if (isExemptRunner(job)) {
        return false;
    }
    let changed = false;
    if (shouldFixRunsOn) {
        changed = fixRunsOn(job) || changed;
    }
    const steps = (job as any).get("steps");
    if (isSeq(steps)) {
        changed = fixSteps(doc, steps, setupAction) || changed;
    }
    return changed;
}

/**
 * Return true if a single job map has any remaining violations.
 * Always returns false for exempt runners.
 */
export function checkJob(
    job: YAMLMap,
    {
        shouldFixRunsOn = false,
        setupAction = DEFAULT_SETUP_ACTION,
    }: JobOptions = {},
): boolean {
    if (isExemptRunner(job)) {
        return false;
    }
    const steps = (job as any).get("steps");
    return (
        (shouldFixRunsOn && checkRunsOn(job)) ||
        (isSeq(steps) && checkSteps(steps, setupAction))
    );
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

type CoreLike = {
    info: (message: string) => void;
    setFailed: (message: string) => void;
};

export default async function fixWorkflows({
    core,
    fixRunsOn: shouldFixRunsOn = false,
    setupAction = DEFAULT_SETUP_ACTION,
}: {
    core: CoreLike;
    fixRunsOn?: boolean;
    setupAction?: string;
}): Promise<void> {
    const files = getFilesToCheck();
    let fixedCount = 0;

    for (const file of files) {
        if (processFile(file, {shouldFixRunsOn, setupAction})) {
            fixedCount++;
        }
    }

    // Verify no violations remain by re-parsing.
    const stillBroken: string[] = [];
    for (const file of files) {
        const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const doc = parseDocument(content);

        let broken = false;
        const jobs = doc.get("jobs");
        if (isMap(jobs)) {
            for (const item of jobs.items) {
                if (
                    isMap(item.value) &&
                    checkJob(item.value as YAMLMap, {
                        shouldFixRunsOn,
                        setupAction,
                    })
                ) {
                    broken = true;
                    break;
                }
            }
        }
        if (broken) {
            stillBroken.push(file);
        }
    }

    if (stillBroken.length > 0) {
        core.setFailed(
            `Could not auto-fix all violations:\n${stillBroken
                .map((f) => `  ${f}`)
                .join("\n")}`,
        );
        return;
    }

    if (fixedCount > 0) {
        core.info(`Fixed ${fixedCount} file(s).`);
    } else {
        core.info("No violations found.");
    }
}
