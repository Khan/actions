/**
 * CI backstop coupling the AWF cache-miss guard to the sub-agent fan-out.
 *
 * `max-turn-cache-misses` (review.md frontmatter, compiled into the AWF
 * api-proxy config) halts a run after N consecutive zero-cache-hit API
 * responses. Every cold Claude Agent SDK session's FIRST request is a
 * guaranteed prompt-cache miss, and the dispatcher fans sessions out in
 * parallel, so the worst-case legitimate burst is one miss per concurrently
 * cold session; whether cache-hitting responses interleave and reset the
 * counter is response-ordering luck (PR #328's re-run lost that race under
 * the compiled default of 5 and the proxy 403'd every remaining lens).
 *
 * The guard value is static config while the fan-out size is a runtime
 * routing decision, so nothing at compile time can couple them; this test
 * is the coupling. It derives the worst case from the same source of truth
 * the dispatcher budgets from (`lib/budgets.ts` `DEFAULT_TIER_BUDGETS`
 * `maxReviewerInvocations`,
 * plus the fixed pipeline agents) and fails any PR that raises the roster
 * cap past the guard's margin without also raising the guard.
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

import {DEFAULT_TIER_BUDGETS} from "./lib/budgets";

const readMd = (url: URL): string => fs.readFileSync(url, "utf-8");
const reviewMd = readMd(new URL("./review.md", import.meta.url));
const installedMd = readMd(
    new URL("../../.github/workflows/review.md", import.meta.url),
);
const lockYml = readMd(
    new URL("../../.github/workflows/review.lock.yml", import.meta.url),
);

const guardValue = (source: string, name: string): number => {
    const matches = [
        ...source.matchAll(/^max-turn-cache-misses:\s*(\d+)\s*$/gm),
    ];
    expect(matches, `${name} carries one max-turn-cache-misses`).toHaveLength(
        1,
    );
    return Number(matches[0]![1]);
};

/**
 * Pipeline agents dispatched beyond the finder roster, each its own cold
 * session: pattern-triage, thread-reconciler, claim-validator,
 * claim-clusterer (dispatch-roster.ts: "Pipeline steps ... never consume a
 * slot", so none of them are inside maxReviewerInvocations).
 *
 * Known undercount, absorbed by the 1.5x margin below rather than modeled:
 * lens agents carry the Agent tool, so a nested Explore/general-purpose
 * spawn is another cold session. Those spawns start after their parent lens
 * has already produced cache-hitting turns, so they are not aligned into
 * the single parallel burst this formula sizes; modeling them would mean
 * inventing a fudge factor with no source of truth to couple to.
 */
const PIPELINE_AGENTS = 4;

describe("the AWF cache-miss guard vs the sub-agent fan-out", () => {
    const worstCaseColdSessions =
        Math.max(
            ...Object.values(DEFAULT_TIER_BUDGETS).map(
                (budget) => budget.maxReviewerInvocations,
            ),
        ) + PIPELINE_AGENTS;

    it("clears the worst-case cold-session burst with margin in the source frontmatter", () => {
        const guard = guardValue(reviewMd, "workflows/review/review.md");
        // >= burst alone is a coin flip away from the PR #328 shape (a
        // single straggler turn-2 miss inside the burst trips it); demand
        // at least a 1.5x margin so a roster bump forces a deliberate
        // guard bump alongside it.
        expect(guard).toBeGreaterThanOrEqual(
            Math.ceil(worstCaseColdSessions * 1.5),
        );
    });

    it("keeps the installed copy and the compiled lock on the same value", () => {
        const source = guardValue(reviewMd, "workflows/review/review.md");
        const installed = guardValue(
            installedMd,
            ".github/workflows/review.md",
        );
        expect(installed).toBe(source);
        // The agent job's compiled AWF config carries the frontmatter value
        // (the detection job's embedded config keeps the upstream default:
        // one session, no fan-out).
        expect(lockYml).toContain(`"maxCacheMisses":${source}`);
    });
});
