import {describe, it, expect} from "vitest";
import {Volume} from "memfs";
import {parseCase} from "./corpus/loader";
import {produceLive} from "./live-producer";
import {
    CASE,
    AGENTS,
    agent,
    scriptedRunner,
    validatorOutput,
    volFs,
} from "./live-producer-fixtures";

describe("produceLive enabled reviewers", () => {
    it("dispatches the opt-in reviewers a case enables, in production rank order", async () => {
        const enabledCase = parseCase(
            {
                ...CASE,
                id: "produce-enabled",
                routerConfig: {
                    lensRules: [
                        {pattern: "src/**", lenses: ["money-payments"]},
                    ],
                    // Listed out of canonical order deliberately.
                    enabledReviewers: [
                        "maintainability",
                        "documentation",
                        "conventions",
                    ],
                },
            },
            "/corpus/incidents/produce-enabled/case.json",
        );
        const {runner, requests} = scriptedRunner({
            "correctness-reviewer": [JSON.stringify({findings: []})],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: [], hunts: []})],
            conventions: [JSON.stringify({findings: []})],
            maintainability: [
                JSON.stringify({
                    findings: [
                        {
                            path: "src/a.ts",
                            line: 1,
                            label: "suggestion (non-blocking, maintainability)",
                            failure_scenario:
                                "the next reader has two names for one value.",
                            subject: "`a` duplicates `b`",
                            discussion:
                                "`const a = 2` at line 1 and `const b = 2` in src/b.ts.",
                        },
                    ],
                }),
            ],
            documentation: [
                JSON.stringify({
                    findings: [
                        {
                            path: "src/a.ts",
                            line: 1,
                            label: "suggestion (non-blocking, documentation)",
                            failure_scenario:
                                "the next reader trusts a comment the change made false.",
                            subject: "Comment describes the old value",
                            discussion:
                                '"// a is always 1" no longer holds: line 1 sets it to 2.',
                        },
                        // The PR-level shape: no path, no line. Production
                        // maps this to a {type: "pr"} anchor; the producer
                        // must too, or a real title/description finding
                        // scores as a true miss (run 31738849545, 0/3).
                        {
                            label: "suggestion (non-blocking, documentation)",
                            failure_scenario:
                                "every reader translates the description's metaphors before they can act.",
                            subject: "Description is built from metaphors",
                            discussion:
                                '"teaches the loop to breathe" names no operation; plainer: "bounds each drain pass".',
                        },
                    ],
                }),
            ],
            "claim-validator": [
                validatorOutput([
                    {
                        id: "produce-enabled:live-documentation-1",
                        verification: "confirmed",
                    },
                    {
                        id: "produce-enabled:live-documentation-2",
                        verification: "confirmed",
                    },
                    {
                        id: "produce-enabled:live-maintainability-1",
                        verification: "confirmed",
                    },
                ]),
            ],
        });
        const agents = new Map(AGENTS);
        agents.set("conventions", agent("conventions"));
        agents.set("documentation", agent("documentation"));
        agents.set("maintainability", agent("maintainability"));

        const result = await produceLive(enabledCase, agents, {
            runner,
            stageDir: "/stage",
            fs: volFs(
                Volume.fromJSON({
                    "/corpus/incidents/produce-enabled/tree/src/a.ts":
                        "const a = 2;\nexport {a};\n",
                }),
            ),
        });

        // Production ranks matched lenses before the enabled opt-ins.
        const finders = requests
            .map((r) => r.name)
            .filter((name) => name !== "claim-validator");
        expect(finders).toEqual([
            "correctness-reviewer",
            "skill-auditor",
            "money-payments",
            "conventions",
            "maintainability",
            "documentation",
        ]);

        // The opt-in reviewer's label-shape output is mapped, not thrown on.
        const docs = result.findings.find((f) => f.source === "documentation");
        expect(docs?.finding.lens).toBe("documentation");
        expect(docs?.finding.severity).toBe("advisory");
        // The path-less finding maps to a pr anchor, mirroring production.
        const prLevel = result.findings.find(
            (f) => f.finding.id === "produce-enabled:live-documentation-2",
        );
        expect(prLevel?.finding.anchor).toEqual({type: "pr"});
        expect(
            result.perAgent.find((a) => a.name === "documentation")?.failed,
        ).toBeFalsy();
        // The maintainability parse path: label shape, mapped to its lens,
        // so the first time it runs is not the graduation A/B.
        const maint = result.findings.find(
            (f) => f.source === "maintainability",
        );
        expect(maint?.finding.lens).toBe("maintainability");
        expect(maint?.finding.severity).toBe("advisory");
        expect(
            result.perAgent.find((a) => a.name === "maintainability")?.failed,
        ).toBeFalsy();
    });
});
