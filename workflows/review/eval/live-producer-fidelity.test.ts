import {describe, expect, it} from "vitest";
import {buildClaims, parseFinderOutput} from "../lib/dispatch-contracts";
import {applyValidation, toCandidate} from "./runner";
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
