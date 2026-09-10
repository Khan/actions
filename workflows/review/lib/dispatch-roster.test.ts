import {describe, it, expect} from "vitest";

import {computeRoster, SHED_RANKING} from "./dispatch-roster";
import {ENABLEABLE_REVIEWERS} from "./routing-config";

// The roster computation, split out of dispatch.test.ts at the max-lines cap.

describe("computeRoster", () => {
    const routing = {
        enabledReviewers: ["holistic", "conventions", "test-adequacy"],
        lensesToSpawn: ["security-auth"],
        runBudget: {maxReviewerInvocations: 4},
    };

    it("fills slots in dispatch-ranking order and records planned sheds", () => {
        const roster = computeRoster("full", routing, false);
        // Defaults, then the matched lens, then opt-ins by inverse shed
        // order; the cap of 4 sheds holistic and conventions.
        expect(roster.finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
            "security-auth",
            "test-adequacy",
        ]);
        expect(roster.shed).toEqual([
            {name: "holistic", cause: "budget"},
            {name: "conventions", cause: "budget"},
        ]);
        expect(roster.triage).toBe(true);
    });

    it("dispatches fixed rosters at flip-gated and fast depths", () => {
        expect(computeRoster("flip-gated", routing, true)).toEqual({
            finders: ["correctness-reviewer"],
            shed: [],
            triage: false,
            reconcile: true,
        });
        expect(computeRoster("fast", routing, false)).toEqual({
            finders: [],
            shed: [],
            triage: false,
            reconcile: false,
        });
    });

    it("never caps below the default finders", () => {
        const roster = computeRoster(
            "full",
            {...routing, runBudget: {maxReviewerInvocations: 1}},
            false,
        );
        expect(roster.finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
        ]);
    });

    it("ranks every enableable reviewer, so none sheds at the unknown-name default", () => {
        // A reviewer missing from SHED_RANKING sheds after `conventions`
        // (rank -0.5) whatever its value; the same pin router.test.ts puts
        // on the invocation cap, here on the ranking.
        for (const name of ENABLEABLE_REVIEWERS) {
            expect(SHED_RANKING).toContain(name);
        }
        expect(new Set(SHED_RANKING).size).toBe(SHED_RANKING.length);
        // The full opt-in set fills in inverse shed order under a cap that
        // fits everything, with the newest advisory reviewers nearest the
        // shed end.
        const roster = computeRoster(
            "full",
            {
                enabledReviewers: [...ENABLEABLE_REVIEWERS],
                lensesToSpawn: [],
                runBudget: {maxReviewerInvocations: 99},
            },
            false,
        );
        expect(roster.finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
            ...[...SHED_RANKING].reverse(),
        ]);
        expect(roster.shed).toEqual([]);
    });
});
