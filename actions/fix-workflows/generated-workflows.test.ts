import {describe, expect, it} from "vitest";

import {isGeneratedWorkflow} from "./index.ts";

/**
 * Which `.github/workflows` entries a generator owns, split from index.test.ts to
 * keep that file inside its 1000-line cap.
 *
 * This predicate is the single source of truth for a set that is duplicated as
 * negated globs in action.yml and cli.ts. It exists because those three places
 * diverged once: the YAML fixer skipped `*.lock.yml` while the oxfmt step did not.
 */

describe("isGeneratedWorkflow", () => {
    // These files are compiler output. Fixing them is worse than useless: the fix
    // is overwritten on the next `gh aw compile`, and the "this file needs
    // updating" annotation invites a maintainer to desync a committed lock from
    // its compiler. The oxfmt globs in action.yml and cli.ts must exclude exactly
    // this set -- they diverged once, and only the formatter step touched locks.
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
