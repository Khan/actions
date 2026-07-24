#!/usr/bin/env -S node -r @swc-node/register

/**
 * Validates and auto-fixes GitHub Actions workflow and action YAML files.
 *
 * Rules enforced:
 * 1. Every `actions/checkout` step must be immediately followed by a
 *    `./.github/actions/setup` step.
 * 2. Every `runs-on:` value must use the conditional expression:
 *    "${{ vars.USE_GITHUB_RUNNERS == 'true' && '<runner>' || 'ephemeral-runner' }}"
 *
 * When a violation is found it is fixed automatically.
 * Comments are preserved via the yaml package's document API.
 * Run prettier after this script to normalize formatting:
 *   pnpm prettier --write ".github/**\/*.yml"
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
    isMap,
    isSeq,
    parseDocument,
    type Document,
    type YAMLMap,
    type YAMLSeq,
} from "yaml";

import {findRepositoryRoot} from "@khan/dev-core";

const repoRoot = findRepositoryRoot();

// The setup action itself contains an internal checkout (for fetching
// additional git history) that is not followed by another setup call.
// Exclude it from validation.
const EXCLUDED = ".github/actions/setup/action.yml";

const YAML_WRITE_OPTIONS = {indent: 4, lineWidth: 0} as const;

/** Matches the required conditional runs-on expression (any runner name). */
const VALID_RUNS_ON_RE =
    /^\$\{\{\s*vars\.USE_GITHUB_RUNNERS\s*==\s*'true'\s*&&\s*'[^']+'\s*\|\|\s*'ephemeral-runner'\s*\}\}$/;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function getFilesToCheck(): string[] {
    const files: string[] = [];

    // Workflow files
    const workflowDir = path.join(repoRoot, ".github", "workflows");
    for (const entry of fs.readdirSync(workflowDir, {withFileTypes: true})) {
        if (
            entry.isFile() &&
            (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))
        ) {
            files.push(path.join(".github", "workflows", entry.name));
        }
    }

    // Action files — recurse into .github/actions/**/action.yml
    const actionDir = path.join(repoRoot, ".github", "actions");
    collectActionFiles(actionDir, ".github/actions", files);

    return files.filter((f) => f !== EXCLUDED);
}

function collectActionFiles(
    absDir: string,
    relDir: string,
    out: string[],
): void {
    for (const entry of fs.readdirSync(absDir, {withFileTypes: true})) {
        const relPath = path.join(relDir, entry.name);
        if (entry.isDirectory()) {
            collectActionFiles(path.join(absDir, entry.name), relPath, out);
        } else if (
            entry.isFile() &&
            (entry.name === "action.yml" || entry.name === "action.yaml")
        ) {
            out.push(relPath);
        }
    }
}

// ---------------------------------------------------------------------------
// Detection and auto-fix via yaml document API
// ---------------------------------------------------------------------------

/**
 * Iterate steps in reverse and inserts a setup step after every checkout
 * step that isn't already followed by one. Also ensures every existing setup
 * step has `timeout-minutes: 5`. Returns true if any changes were made.
 */
export function fixSteps(doc: Document, steps: YAMLSeq): boolean {
    let changed = false;
    // Iterate in reverse so insertions don't shift the indices we still need.
    for (let i = steps.items.length - 1; i >= 0; i--) {
        const step = steps.items[i];
        if (!isMap(step)) {
            continue;
        }

        const uses = step.get("uses");

        // Ensure existing setup steps have timeout-minutes: 5.
        if (
            typeof uses === "string" &&
            uses.includes(".github/actions/setup")
        ) {
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

        const nextStep = steps.items[i + 1];
        const nextUses = isMap(nextStep)
            ? String(nextStep.get("uses") ?? "")
            : "";
        if (nextUses.includes(".github/actions/setup")) {
            continue;
        }

        const setupStep = doc.createNode({
            name: "Setup",
            uses: "./.github/actions/setup",
            "timeout-minutes": 5,
            with: {
                "ssh-key": "${{ secrets.KHAN_ACTIONS_BOT_SSH_PRIVATE_KEY }}",
            },
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
export function checkSteps(steps: YAMLSeq): boolean {
    for (let i = 0; i < steps.items.length; i++) {
        const step = steps.items[i];
        if (!isMap(step)) {
            continue;
        }
        const uses = step.get("uses");
        if (typeof uses !== "string") {
            continue;
        }
        if (uses.includes(".github/actions/setup")) {
            const timeout = step.get("timeout-minutes");
            if (timeout === undefined || timeout === null) {
                return true;
            }
            continue;
        }
        if (!uses.startsWith("actions/checkout")) {
            continue;
        }
        const nextUses = isMap(steps.items[i + 1])
            ? String((steps.items[i + 1] as any).get("uses") ?? "")
            : "";
        if (!nextUses.includes(".github/actions/setup")) {
            return true;
        }
    }
    return false;
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

/**
 * Parse the file, fix any violations, and write it back if changed.
 * Returns true if the file was modified.
 */
function processFile(filePath: string): boolean {
    const absPath = path.join(repoRoot, filePath);
    const content = fs.readFileSync(absPath, "utf8");
    const doc = parseDocument(content);
    let changed = false;

    // Workflow files: jobs.<id>.runs-on and jobs.<id>.steps
    const jobs = doc.get("jobs");
    if (isMap(jobs)) {
        for (const item of jobs.items) {
            if (!isMap(item.value)) {
                continue;
            }
            changed = fixRunsOn(item.value as YAMLMap) || changed;
            const steps = (item.value as any).get("steps");
            if (isSeq(steps)) {
                changed = fixSteps(doc, steps) || changed;
            }
        }
    }

    // Composite action files: runs.steps
    const runs = doc.get("runs");
    if (isMap(runs) && runs.get("using") === "composite") {
        const steps = (runs as any).get("steps");
        if (isSeq(steps)) {
            changed = fixSteps(doc, steps) || changed;
        }
    }

    if (changed) {
        console.log(`  Fixed ${filePath}`);
        fs.writeFileSync(absPath, doc.toString(YAML_WRITE_OPTIONS), "utf8");
    }
    return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
    const files = getFilesToCheck();
    let fixedCount = 0;

    for (const file of files) {
        if (processFile(file)) {
            fixedCount++;
        }
    }

    // Verify no violations remain by re-parsing.
    const stillBroken: string[] = [];
    for (const file of files) {
        const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
        const doc = parseDocument(content);

        const hasStepsViolation = (steps: any) =>
            isSeq(steps) && checkSteps(steps);

        let broken = false;
        const jobs = doc.get("jobs");
        if (isMap(jobs)) {
            for (const item of jobs.items) {
                if (isMap(item.value)) {
                    if (
                        checkRunsOn(item.value as YAMLMap) ||
                        hasStepsViolation((item.value as any).get("steps"))
                    ) {
                        broken = true;
                        break;
                    }
                }
            }
        }
        const runs = doc.get("runs");
        if (isMap(runs) && runs.get("using") === "composite") {
            if (hasStepsViolation((runs as any).get("steps"))) {
                broken = true;
            }
        }
        if (broken) {
            stillBroken.push(file);
        }
    }

    if (stillBroken.length > 0) {
        console.error("\n❌ Could not auto-fix all violations:");
        for (const f of stillBroken) {
            console.error(`  ${f}`);
        }
        process.exit(1);
    }

    if (fixedCount > 0) {
        console.log(`✅ Fixed ${fixedCount} file(s).`);
    } else {
        console.log("✅ No violations found.");
    }
}
