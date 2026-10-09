import {describe, expect, it} from "vitest";
import {
    applyVerifications,
    buildClaims,
    parseFinderOutput,
} from "../lib/dispatch-contracts";
import {renderClaimComment} from "../lib/submission-render";
import {parseCase} from "./corpus/loader";
import {applyValidation, runCase, toCandidate} from "./runner";
import {produceLive} from "./live-producer";
import {
    volFs,
    CASE,
    caseVol,
    AGENTS,
    LABEL_FINDING,
    scriptedRunner,
} from "./live-producer.fixtures";

describe("live claim fidelity", () => {
    it.each([
        "question (non-blocking)",
        "thought (non-blocking)",
        "note (non-blocking)",
        "nitpick (non-blocking)",
        "todo (blocking)",
    ])("preserves %s through recorded replay and validation", async (label) => {
        const output = JSON.stringify({
            findings: [
                {...LABEL_FINDING, label, suggestion: "// sketch\n".repeat(9)},
            ],
        });
        const {runner} = scriptedRunner({
            "correctness-reviewer": [output],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: []})],
            "claim-validator": [JSON.stringify({claims: []})],
        });
        const vol = caseVol();
        const produced = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(vol),
        });
        const [production] = buildClaims(
            parseFinderOutput("correctness-reviewer", output, new Set())
                .candidates,
        );
        const staged = JSON.parse(
            vol.readFileSync("/stage/context/claims.json", "utf8") as string,
        );
        expect(staged[0].label).toBe(label);
        const corpusCase = parseCase(
            {...CASE, findings: produced.findings, validation: []},
            "label-replay",
        );
        expect(corpusCase.findings[0]).toHaveProperty("labelOverride", label);
        const id = corpusCase.findings[0].finding.id;
        for (const verification of [
            undefined,
            "confirmed",
            "plausible",
        ] as const) {
            const validation =
                verification === undefined ? [] : [{id, verification}];
            const replay = runCase(corpusCase, {validation});
            const [claim] = applyVerifications(
                [{...production, id}],
                verification === undefined ? {} : {[id]: {verification}},
            );
            expect(replay.postedLabels).toEqual([claim.label]);
            expect(replay.postedCandidates[0].body).toBe(
                renderClaimComment(claim),
            );
            expect(replay.postedCandidates[0].body.includes("A sketch,")).toBe(
                label === "todo (blocking)",
            );
            expect(replay.verdict.event).toBe(
                claim.label === "todo (blocking)"
                    ? "REQUEST_CHANGES"
                    : "APPROVE",
            );
            const corrected = applyValidation(replay.postedCandidates, [
                {
                    id,
                    verification: "confirmed",
                    corrected: {discussion: "Corrected detail."},
                },
            ]).validated[0];
            expect(corrected.label).toBe(claim.label);
            expect(corrected.blocking).toBe(claim.label === "todo (blocking)");
        }
    });

    it("preserves the production subject/body split and validator corrections", async () => {
        const id = "produce-case:live-correctness-reviewer-1";
        const corrected = {
            subject: "The caller loses the diagnostic reason",
            discussion:
                "The failure returns no debug reason. Reuse the logged error.",
            suggestion: "return debugMessage(loggedError)",
        };
        const output = JSON.stringify({findings: [LABEL_FINDING]});
        const {runner} = scriptedRunner({
            "correctness-reviewer": [output],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: []})],
            "claim-validator": [
                JSON.stringify({
                    claims: [
                        {
                            id,
                            verification: "confirmed",
                            corrected,
                        },
                    ],
                }),
            ],
        });
        const vol = caseVol();
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(vol),
        });
        const staged = JSON.parse(
            vol.readFileSync("/stage/context/claims.json", "utf8") as string,
        );
        const production = buildClaims(
            parseFinderOutput("correctness-reviewer", output, new Set())
                .candidates,
        )[0];
        expect(staged[0].subject).toBe(production.subject);
        expect(staged[0].discussion).toBe(production.discussion);
        expect(result.validation[0]).toHaveProperty("corrected", corrected);
        const posted = applyValidation(
            result.findings.map(toCandidate),
            result.validation,
        ).validated[0];
        expect(posted.finding.summary).toBe(corrected.subject);
        expect(posted.finding.model_authored_prose).toBe(corrected.discussion);
        expect(posted.finding.suggested_patch).toBe(corrected.suggestion);
    });
});
