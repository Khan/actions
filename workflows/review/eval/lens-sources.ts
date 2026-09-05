/**
 * The producer-side table the live eval uses to turn an agent name into the
 * `lens` and `source` a finding carries. Shared by `live-producer.ts` (which
 * stamps findings) and `live-match.ts` (which breaks spec ties on the stamped
 * `source`), because the two namespaces diverge in one place: the default
 * `skill-auditor` writes `conventions` findings under source `skill`, so a
 * spec whose `lens` is `conventions` has to accept both sources or it can
 * never win its own tie.
 */

import type {Lens} from "../lib/finding-schema";

/**
 * Every reviewer that emits the label-bearing shape rather than the
 * structured finding schema: the two defaults, plus the opt-in whole-change
 * reviewers (reachable since a case may `enable` them). A name missing here
 * falls through to the specialist-lens branch in `live-producer.ts` and
 * throws on the first finding, so keep this in step with
 * ENABLEABLE_REVIEWERS.
 */
export const LABEL_SHAPE_REVIEWERS: Readonly<
    Record<string, {lens: Lens; source: string}>
> = {
    "correctness-reviewer": {lens: "correctness", source: "correctness"},
    "skill-auditor": {lens: "conventions", source: "skill"},
    holistic: {lens: "holistic", source: "holistic"},
    completeness: {lens: "completeness", source: "completeness"},
    "test-adequacy": {lens: "test-adequacy", source: "test-adequacy"},
    "first-principles": {
        lens: "first-principles",
        source: "first-principles",
    },
    conventions: {lens: "conventions", source: "conventions"},
    documentation: {lens: "documentation", source: "documentation"},
    maintainability: {lens: "maintainability", source: "maintainability"},
};

/**
 * Whether a finding stamped `source` was produced by the reviewer that owns
 * `lens`. Specialist agents are named for their lens, so the source IS the
 * lens name; the label-shape reviewers go through the table above.
 */
export const sourceProducesLens = (source: string, lens: string): boolean =>
    source === lens ||
    Object.values(LABEL_SHAPE_REVIEWERS).some(
        (entry) => entry.source === source && entry.lens === lens,
    );
