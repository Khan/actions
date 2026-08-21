import {describe, it, expect} from "vitest";

import {suppressOpenThreadDuplicates} from "./dedup-threads";
import type {Claim} from "./dispatch-contracts";

/**
 * Open-thread suppression for pr-level (pathless) claims, split from
 * `dedup.test.ts` for the file-size budget. See that file for the
 * same-path suppression suite and the fixture provenance conventions.
 */

const claim = (over: Partial<Claim> & {id: string; source: string}): Claim => ({
    path: "services/ai-guide/memory/expiration.go",
    line: 38,
    label: "issue (blocking)",
    subject: "s",
    discussion: "d",
    failure_scenario: "f",
    confidence: 0.7,
    ...over,
});

const openThread = (over: Record<string, unknown> = {}) => ({
    thread_id: "T1",
    path: "services/ai-guide/memory/expiration.go",
    body: "**issue (blocking):** opener",
    ...over,
});

/**
 * The pr-level tier's real fixtures: webapp#41290 review 4867627688,
 * where a reviewer re-found the data race two open blocking threads
 * (r3721196429, r3721196434) already tracked, anchored it pr-level (it
 * spans three files), and the path-gated suppression re-posted the full
 * finding into the review body under the accountability section listing
 * those same threads. Texts abridged from the posted bodies only where
 * marked; the load-bearing vocabulary is verbatim.
 */
describe("suppressOpenThreadDuplicates: pr-level claims (webapp#41290)", () => {
    const dataRaceDiscussion =
        "Data race: the moderation goroutine's MakeMutableCopy() appends to promptVariablesCopies concurrently with the completion goroutine's MergedSnapshot(), which reads that slice without the mutex. Introduced by this change. applyChanges' own new doc comment (chat/ask/modify_conversation.go:275-277) states the precondition: only call it after the modifier tracegroup has been waited, because it reads promptVariablesCopies without taking promptVariablesCopiesMu. The parallel path violates that precondition: MergedSnapshot() is called inside the modifiersAndMainCompletion closure (chat_with_modifiers.go:214) after ApplyPreFlightModifiers has waited only its own internal modifiersGroup — the moderation goroutine is a sibling in turnGroup, not yet joined, and it registers its copy via MakeMutableCopy() evaluated inside turnGroup.Go (moderation_helpers.go:154). What I checked: (1) MakeMutableCopy appends under promptVariablesCopiesMu while applyChanges iterates m.promptVariablesCopies with no lock; (2) the moderation modifier itself never writes to its promptVariables copy, so today the race is on the slice header, not the copy's map contents. Minimal fix: hoist the copy out of the goroutine — evaluate moderationPromptVars := promptVariablesMerger.MakeMutableCopy() in moderateAndAnswerInParallel before the turnGroup.Go calls (the go statement then provides the happens-before), and pass that variable into ExecutePreFlightModifierV2.";
    const dataRacePrLevel = claim({
        id: "correctness-reviewer-1",
        source: "correctness-reviewer",
        path: undefined,
        line: undefined,
        subject:
            "Data race: the moderation goroutine's MakeMutableCopy() appends to promptVariablesCopies concurrently with the completion goroutine's MergedSnapshot(), which reads that slice without the mutex.",
        discussion: dataRaceDiscussion,
        // The salvaged shape: the correctness pass omits
        // failure_scenario and gets its subject back as one.
        failure_scenario:
            "Data race: the moderation goroutine's MakeMutableCopy() appends to promptVariablesCopies concurrently with the completion goroutine's MergedSnapshot(), which reads that slice without the mutex.",
    });
    const openDataRaceThread = openThread({
        thread_id: "T-r3721196429",
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        body: '**issue (blocking):** Data race: moderation goroutine\'s MakeMutableCopy() appends to the merger\'s copies slice while the completion goroutine\'s MergedSnapshot() iterates it unlocked. Introduced by this change. What I checked: PromptVariablesMerger in chat/ask/modify_conversation.go — MakeMutableCopy appends under promptVariablesCopiesMu, while applyChanges (used by MergedSnapshot) intentionally reads promptVariablesCopies without the lock and documents "Only call it after the modifier tracegroup has been waited"; tracegroup is an errgroup fork whose Wait() (sync.WaitGroup) is the only happens-before edge between the two turnGroup goroutines, and MergedSnapshot runs before that Wait. The content impact is benign today — moderationCheck never writes to its prompt-variables copy, so a missed copy changes nothing — but the memory-model race is real and will surface as -race failures on the new tests. Fix is small: hoist the copy out of the goroutine so goroutine-start provides the happens-before edge — e.g. `moderationPromptVariables := promptVariablesMerger.MakeMutableCopy()` immediately before `turnGroup.Go("moderation", ...)` and pass that variable here.',
    });
    const openUnrelatedThread = openThread({
        thread_id: "T-r3721196448",
        path: "services/ai-guide/chat/ask/v2/moderation_helpers.go",
        body: "**suggestion (non-blocking):** Completion-error propagation on the parallel path is untested. Every parallel test (TestModerateWhileAnswering*) uses NewCGCTestClient / a client whose non-CGC completion succeeds; TestModerateWhileAnsweringFailedCheckDoesNotRelease only fails the CGC request, not the completion. The completionErr capture-and-return wiring is new and non-trivial, and its failure path is unverified.",
    });

    it("suppresses a pr-level re-flag of an open blocking thread", () => {
        const {kept, suppressed} = suppressOpenThreadDuplicates(
            [dataRacePrLevel],
            [openUnrelatedThread, openDataRaceThread],
        );
        expect(kept).toEqual([]);
        expect(suppressed).toEqual([
            {
                id: "correctness-reviewer-1",
                source: "correctness-reviewer",
                label: "issue (blocking)",
                thread_id: "T-r3721196429",
                threadBlocking: true,
            },
        ]);
    });

    it("keeps a pr-level claim against unrelated open threads", () => {
        const {kept, suppressed} = suppressOpenThreadDuplicates(
            [dataRacePrLevel],
            [openUnrelatedThread],
        );
        expect(kept).toHaveLength(1);
        expect(suppressed).toEqual([]);
    });

    it("holds a pr-level claim to the stricter floor a same-path claim clears", () => {
        // 8 content tokens -> 7 shared bigrams: clears the same-path
        // tier (>= 6) but not the pr-level tier (>= 8), so the SAME
        // text suppresses with an anchor and posts without one.
        const sentence =
            "Retention cutoff computes the wrong unit and never expires memories.";
        const thread = openThread({body: `**issue (blocking):** ${sentence}`});
        const anchored = claim({
            id: "a",
            source: "correctness-reviewer",
            subject: sentence,
            discussion: "d",
            failure_scenario: sentence,
        });
        expect(
            suppressOpenThreadDuplicates([anchored], [thread]).suppressed,
        ).toHaveLength(1);
        const prLevel = claim({
            ...anchored,
            id: "b",
            path: undefined,
            line: undefined,
        });
        expect(
            suppressOpenThreadDuplicates([prLevel], [thread]).suppressed,
        ).toEqual([]);
    });
});
