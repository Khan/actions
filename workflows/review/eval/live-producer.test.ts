import {describe, it, expect} from "vitest";
import {Volume} from "memfs";

import {parseCase} from "./corpus/loader";
import {
    produceLive,
    resolveRuntimeImports,
    type LiveAgentRequest,
    type LiveAgentRunner,
} from "./live-producer";
import type {ExtractedAgent} from "./agent-extract";
import type {StageFs} from "./live-stage";

/** Adapt a memfs volume to the staging fs seam. */
const volFs = (vol: InstanceType<typeof Volume>): StageFs => ({
    existsSync: (p) => vol.existsSync(p),
    mkdirSync: (p, opts) => {
        vol.mkdirSync(p, opts);
    },
    readdirSync: (p, opts) =>
        vol.readdirSync(p, opts) as unknown as ReturnType<
            StageFs["readdirSync"]
        >,
    readFileSync: (p, enc) => vol.readFileSync(p, enc) as string,
    writeFileSync: (p, data) => {
        vol.writeFileSync(p, data);
    },
});

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

const CASE = parseCase(
    {
        id: "produce-case",
        tags: ["live"],
        category: "incident-repro",
        description: "a producible case",
        changedFiles: [{path: "src/a.ts", status: "modified"}],
        expected: {verdict: "APPROVE"},
        diff: DIFF,
        routerConfig: {
            lensRules: [{pattern: "src/**", lenses: ["money-payments"]}],
        },
        live: {
            prContext: {
                title: "t",
                description: "",
                author: "a",
                baseBranch: "main",
            },
        },
    },
    "/corpus/incidents/produce-case/case.json",
);

const caseVol = () =>
    Volume.fromJSON({
        "/corpus/incidents/produce-case/tree/src/a.ts":
            "const a = 2;\nexport {a};\n",
    });

const agent = (name: string, prompt = `${name} prompt`): ExtractedAgent => ({
    name,
    description: `${name} description`,
    model: "claude-opus-4-8",
    prompt,
});

const AGENTS = new Map(
    [
        "correctness-reviewer",
        "skill-auditor",
        "money-payments",
        "claim-validator",
    ].map((name) => [name, agent(name)]),
);

const LABEL_FINDING = {
    path: "src/a.ts",
    line: 1,
    label: "issue (blocking)",
    failure_scenario: "with input X the constant is wrong and Y crashes.",
    subject: "Constant changed incorrectly",
    discussion: "The new value breaks the Y invariant.",
};

const SCHEMA_FINDING = {
    schema_version: 2,
    id: "lens-money-1",
    lens: "money-payments",
    anchor: {type: "line", path: "src/a.ts", line: 1, side: "RIGHT"},
    severity: "advisory",
    confidence: 0.6,
    evidence_trace: ["read src/a.ts line 1"],
    failure_scenario: "amounts drift by a cent on large values.",
    producing_hunt: "money:rounding",
    model_authored_prose: "Money should stay in integer cents.",
};

/** A scripted runner: outputs queued per agent name, requests recorded. */
const scriptedRunner = (
    scripts: Record<string, string[]>,
): {runner: LiveAgentRunner; requests: LiveAgentRequest[]} => {
    const requests: LiveAgentRequest[] = [];
    const cursors: Record<string, number> = {};
    const runner: LiveAgentRunner = async (request) => {
        requests.push(request);
        const queue = scripts[request.name] ?? [];
        const cursor = cursors[request.name] ?? 0;
        cursors[request.name] = cursor + 1;
        const output = queue[Math.min(cursor, queue.length - 1)] ?? "{}";
        return {output, usd: 0.25, turns: 3, wallMs: 1000};
    };
    return {runner, requests};
};

const validatorOutput = (
    entries: {id: string; verification: string; confidence?: number}[],
): string =>
    JSON.stringify({
        claims: entries.map((entry) => ({...entry, reason: "checked"})),
    });

describe("produceLive", () => {
    it("runs the default finders plus routed lenses and the validator", async () => {
        const {runner, requests} = scriptedRunner({
            "correctness-reviewer": [
                JSON.stringify({files: [], findings: [LABEL_FINDING]}),
            ],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [
                JSON.stringify({findings: [SCHEMA_FINDING], hunts: []}),
            ],
            "claim-validator": [
                validatorOutput([
                    {
                        id: "produce-case:live-correctness-reviewer-1",
                        verification: "confirmed",
                        confidence: 0.9,
                    },
                    {
                        id: "produce-case:lens-money-1",
                        verification: "plausible",
                        confidence: 0.3,
                    },
                ]),
            ],
        });
        const vol = caseVol();
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(vol),
        });

        expect(requests.map((r) => r.name).sort()).toEqual([
            "claim-validator",
            "correctness-reviewer",
            "money-payments",
            "skill-auditor",
        ]);
        // Every dispatch runs in the staged checkout.
        expect(new Set(requests.map((r) => r.cwd))).toEqual(
            new Set(["/stage/checkout"]),
        );

        // The label-shape finding is mapped into the schema.
        const correctness = result.findings.find(
            (f) => f.source === "correctness",
        );
        expect(correctness?.finding.id).toBe(
            "produce-case:live-correctness-reviewer-1",
        );
        expect(correctness?.finding.severity).toBe("blocking");
        expect(correctness?.finding.lens).toBe("correctness");
        expect(correctness?.finding.confidence).toBe(0.7);
        // The lens finding passes through as-is.
        const lens = result.findings.find((f) => f.source === "money-payments");
        expect(lens?.finding.id).toBe("produce-case:lens-money-1");

        // claims.json staged for the validator with code-owned labels.
        const claims = JSON.parse(
            vol.readFileSync("/stage/context/claims.json", "utf8") as string,
        );
        expect(claims.map((c: {id: string}) => c.id).sort()).toEqual(
            [
                "produce-case:lens-money-1",
                "produce-case:live-correctness-reviewer-1",
            ].sort(),
        );
        expect(
            claims.find(
                (c: {id: string}) =>
                    c.id === "produce-case:live-correctness-reviewer-1",
            ).label,
        ).toBe("issue (blocking)");

        // Verifications parsed into the corpus validation shape.
        expect(result.validation).toEqual([
            {
                id: "produce-case:live-correctness-reviewer-1",
                verification: "confirmed",
                confidence: 0.9,
            },
            {
                id: "produce-case:lens-money-1",
                verification: "plausible",
                confidence: 0.3,
            },
        ]);

        // Cost accounting: one entry per dispatched agent.
        expect(result.perAgent.length).toBe(4);
        expect(result.perAgent.every((a) => a.usd === 0.25)).toBe(true);
    });

    it("retries once on malformed output and keeps the second answer", async () => {
        const {runner, requests} = scriptedRunner({
            "correctness-reviewer": [
                "sorry, here is prose instead of JSON",
                JSON.stringify({findings: [LABEL_FINDING]}),
            ],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: []})],
            "claim-validator": [
                validatorOutput([
                    {
                        id: "produce-case:live-correctness-reviewer-1",
                        verification: "confirmed",
                    },
                ]),
            ],
        });
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(caseVol()),
        });
        const report = result.perAgent.find(
            (a) => a.name === "correctness-reviewer",
        );
        expect(report?.retried).toBe(true);
        expect(report?.failed).toBeUndefined();
        expect(report?.usd).toBeCloseTo(0.5, 10); // both attempts billed
        expect(result.findings.length).toBe(1);
        // The retry prompt carries the rejection reason.
        const retryPrompt = requests.filter(
            (r) => r.name === "correctness-reviewer",
        )[1]?.prompt;
        expect(retryPrompt).toMatch(/previous output was rejected/);
    });

    it("marks a twice-failed agent failed and keeps everyone else", async () => {
        const {runner} = scriptedRunner({
            "correctness-reviewer": ["not json", "still not json"],
            "skill-auditor": [
                JSON.stringify({
                    findings: [
                        {
                            ...LABEL_FINDING,
                            skill: "error-handling",
                            label: "issue (blocking, best-practice)",
                        },
                    ],
                }),
            ],
            "money-payments": [JSON.stringify({findings: []})],
            "claim-validator": [
                validatorOutput([
                    {
                        id: "produce-case:live-skill-auditor-1",
                        verification: "refuted",
                    },
                ]),
            ],
        });
        const vol = caseVol();
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(vol),
        });
        expect(
            result.perAgent.find((a) => a.name === "correctness-reviewer")
                ?.failed,
        ).toMatch(/malformed output/);
        const skill = result.findings.find((f) => f.source === "skill");
        expect(skill?.finding.lens).toBe("conventions");
        // The skill name rides into the claims for the validator.
        const claims = JSON.parse(
            vol.readFileSync("/stage/context/claims.json", "utf8") as string,
        );
        expect(claims[0].skill).toBe("error-handling");
        expect(result.validation[0]?.verification).toBe("refuted");
    });

    it("skips the validator entirely when no findings were produced", async () => {
        const {runner, requests} = scriptedRunner({
            "correctness-reviewer": [JSON.stringify({findings: []})],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: []})],
        });
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(caseVol()),
        });
        expect(result.findings).toEqual([]);
        expect(result.validation).toEqual([]);
        expect(requests.some((r) => r.name === "claim-validator")).toBe(false);
    });

    it("prefixes colliding finding ids with the producing agent", async () => {
        const {runner} = scriptedRunner({
            "correctness-reviewer": [JSON.stringify({findings: []})],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [
                JSON.stringify({
                    findings: [
                        SCHEMA_FINDING,
                        {...SCHEMA_FINDING, id: "lens-money-1"},
                    ],
                }),
            ],
            "claim-validator": [validatorOutput([])],
        });
        const result = await produceLive(CASE, AGENTS, {
            runner,
            stageDir: "/stage",
            fs: volFs(caseVol()),
        });
        expect(result.findings.map((f) => f.finding.id).sort()).toEqual([
            "money-payments:produce-case:lens-money-1",
            "produce-case:lens-money-1",
        ]);
    });

    it("throws when the roster names an agent review.md does not define", async () => {
        const {runner} = scriptedRunner({});
        const agents = new Map([
            ["correctness-reviewer", agent("correctness-reviewer")],
        ]);
        await expect(
            produceLive(CASE, agents, {
                runner,
                stageDir: "/stage",
                fs: volFs(caseVol()),
            }),
        ).rejects.toThrow(/"skill-auditor" is not defined/);
    });
});

describe("resolveRuntimeImports", () => {
    it("inlines imports present in the checkout and notes absent required ones", () => {
        const vol = Volume.fromJSON({
            "/checkout/.github/aw/review/skills.md": "## skills index",
        });
        const fs = volFs(vol);
        const prompt = [
            "Skills:\n{{#runtime-import .github/aw/review/skills.md}}",
            "CI:\n{{#runtime-import .github/aw/review/ci-tooling.md}}",
        ].join("\n");
        const resolved = resolveRuntimeImports(prompt, "/checkout", fs);
        expect(resolved).toContain("## skills index");
        expect(resolved).toContain("(not configured for this eval case)");
        expect(resolved).not.toMatch(/runtime-import/);
    });

    it("resolves a missing optional import to nothing, like production", () => {
        const vol = Volume.fromJSON({
            "/checkout/.github/aw/review/lenses/security-auth.md":
                "## repo security payload",
        });
        const fs = volFs(vol);
        const prompt = [
            "Payload:\n{{#runtime-import? .github/aw/review/lenses/security-auth.md}}",
            "Absent:\n{{#runtime-import? .github/aw/review/lenses/money-payments.md}}",
        ].join("\n");
        const resolved = resolveRuntimeImports(prompt, "/checkout", fs);
        expect(resolved).toContain("## repo security payload");
        expect(resolved).toContain("Absent:\n");
        expect(resolved).not.toContain("(not configured for this eval case)");
        expect(resolved).not.toMatch(/runtime-import/);
    });

    it("reaches the dispatched prompts through produceLive", async () => {
        const {runner, requests} = scriptedRunner({
            "correctness-reviewer": [JSON.stringify({findings: []})],
            "skill-auditor": [JSON.stringify({findings: []})],
            "money-payments": [JSON.stringify({findings: []})],
        });
        const vol = caseVol();
        vol.mkdirSync("/corpus/incidents/produce-case/tree/.github/aw/review", {
            recursive: true,
        });
        vol.writeFileSync(
            "/corpus/incidents/produce-case/tree/.github/aw/review/skills.md",
            "## the case skills index",
        );
        const agents = new Map(AGENTS);
        agents.set(
            "skill-auditor",
            agent(
                "skill-auditor",
                "Audit skills:\n{{#runtime-import .github/aw/review/skills.md}}",
            ),
        );
        await produceLive(CASE, agents, {
            runner,
            stageDir: "/stage",
            fs: volFs(vol),
        });
        const skillPrompt = requests.find(
            (r) => r.name === "skill-auditor",
        )?.prompt;
        expect(skillPrompt).toContain("## the case skills index");
    });
});
