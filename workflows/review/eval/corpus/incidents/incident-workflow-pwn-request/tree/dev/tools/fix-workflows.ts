#!/usr/bin/env -S node --experimental-strip-types

/**
 * Auto-fixes GitHub Actions workflow YAML: every `actions/checkout` step must
 * be immediately followed by a `./.github/actions/setup` step. Comments are
 * preserved via the yaml package's document API.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {isMap, isSeq, parseDocument, type Document, type YAMLSeq} from "yaml";

const WORKFLOW_DIR = ".github/workflows";

/** Insert a setup step after every checkout step that lacks one. */
export function fixSteps(doc: Document, steps: YAMLSeq): boolean {
    let changed = false;
    // Reverse order so insertions do not shift indices still to visit.
    for (let i = steps.items.length - 1; i >= 0; i--) {
        const step = steps.items[i];
        if (!isMap(step)) {
            continue;
        }
        const uses = step.get("uses");
        if (typeof uses !== "string" || !uses.startsWith("actions/checkout")) {
            continue;
        }
        const next = steps.items[i + 1];
        const nextUses = isMap(next) ? String(next.get("uses") ?? "") : "";
        if (nextUses.includes(".github/actions/setup")) {
            continue;
        }
        steps.items.splice(
            i + 1,
            0,
            doc.createNode({name: "Setup", uses: "./.github/actions/setup"}),
        );
        changed = true;
    }
    return changed;
}

let fixed = 0;
for (const name of fs.readdirSync(WORKFLOW_DIR)) {
    const file = path.join(WORKFLOW_DIR, name);
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    const jobs = doc.get("jobs");
    if (!isMap(jobs)) {
        continue;
    }
    let changed = false;
    for (const {value: job} of jobs.items) {
        const steps = isMap(job) ? job.get("steps") : undefined;
        if (isSeq(steps)) {
            changed = fixSteps(doc, steps) || changed;
        }
    }
    if (changed) {
        fs.writeFileSync(file, doc.toString({indent: 4}), "utf8");
        fixed++;
    }
}
console.log(fixed > 0 ? `Fixed ${fixed} file(s).` : "No violations found.");
