import * as fs from "fs";
import {describe, expect, it} from "vitest";

import {generatedWorkflowSkipGlobs, isGeneratedWorkflow} from "./index.ts";

/**
 * Which `.github/workflows` entries a generator owns, split from index.test.ts to
 * keep that file inside its 1000-line cap.
 *
 * `GENERATED_WORKFLOWS` is the single source of truth for a set that three places
 * act on: the fixer calls `isGeneratedWorkflow`, cli.ts derives its oxfmt globs
 * from `generatedWorkflowSkipGlobs()`, and action.yml's bash step -- which cannot
 * import either -- hand-copies those globs. The last of those is what this file's
 * second describe block pins, because the three diverged once already: the YAML
 * fixer skipped `*.lock.yml` while the oxfmt step reformatted it.
 */

const actionYml = fs.readFileSync(
    new URL("./action.yml", import.meta.url),
    "utf-8",
);

/**
 * The oxfmt step's `run:` body alone, so that a quoted `!...` added to some other
 * step cannot pass for one of the skip globs.
 */
function oxfmtStep(): string {
    const afterName = actionYml.split(
        "- name: Format YAML files with oxfmt",
    )[1];
    if (afterName == null) {
        throw new Error(
            "action.yml has no oxfmt step; rename the test with it",
        );
    }
    return afterName.split("\n        - name:")[0]!;
}

describe("isGeneratedWorkflow", () => {
    // These files are compiler output. Fixing them is worse than useless: the fix
    // is overwritten on the next `gh aw compile`, and the "this file needs
    // updating" annotation invites a maintainer to desync a committed lock from
    // its compiler.
    it("skips compiled agentic workflow locks", () => {
        expect(isGeneratedWorkflow("review.lock.yml")).toBe(true);
        expect(isGeneratedWorkflow("autofix.lock.yml")).toBe(true);
    });

    it("skips gh-aw's maintenance workflow, which is not named *.lock.yml", () => {
        expect(isGeneratedWorkflow("agentics-maintenance.yml")).toBe(true);
    });

    it("still checks hand-written workflows, including lookalikes", () => {
        expect(isGeneratedWorkflow("node-ci.yml")).toBe(false);
        expect(isGeneratedWorkflow("validate-workflows.yml")).toBe(false);
        // Not a lock: the suffix test is `.lock.yml`, not `lock` anywhere.
        expect(isGeneratedWorkflow("lock-threads.yml")).toBe(false);
        expect(isGeneratedWorkflow("agentics-maintenance-notes.yml")).toBe(
            false,
        );
    });
});

describe("action.yml's copy of the skip globs", () => {
    // The only site that cannot derive its skip set from GENERATED_WORKFLOWS, so
    // it is the only one that can silently fall behind a fourth entry. This test
    // is the substitute for the import it cannot do.
    it("matches generatedWorkflowSkipGlobs()", () => {
        const literals = [...oxfmtStep().matchAll(/'(![^']+)'/g)].map(
            (match) => match[1],
        );
        expect(literals).toEqual(generatedWorkflowSkipGlobs());
    });

    // Negating patterns the positive glob never selects would leave the locks
    // unformatted for the wrong reason, and would quietly stop the negations
    // being load-bearing if that glob were narrowed.
    it("still formats workflows recursively, so the negations subtract from that set", () => {
        expect(oxfmtStep()).toContain('".github/workflows/**/*.yml"');
    });
});
