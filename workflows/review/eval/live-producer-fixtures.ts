import {Volume} from "memfs";
import {parseCase} from "./corpus/loader";
import type {LiveAgentRunner, LiveAgentRequest} from "./live-producer";
import type {ExtractedAgent} from "./agent-extract";
import type {StageFs} from "./live-stage";
import type {ModelTokens} from "../lib/pricing";

/** Adapt a memfs volume to the staging fs seam. */
export const volFs = (vol: InstanceType<typeof Volume>): StageFs => ({
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

export const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-const a = 1;",
    "+const a = 2;",
    " export {a};",
    "",
].join("\n");

export const CASE = parseCase(
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

export const caseVol = () =>
    Volume.fromJSON({
        "/corpus/incidents/produce-case/tree/src/a.ts":
            "const a = 2;\nexport {a};\n",
    });

export const agent = (
    name: string,
    prompt = `${name} prompt`,
): ExtractedAgent => ({
    name,
    description: `${name} description`,
    model: "claude-opus-4-8",
    prompt,
});

export const AGENTS = new Map(
    [
        "correctness-reviewer",
        "skill-auditor",
        "money-payments",
        "claim-validator",
    ].map((name) => [name, agent(name)]),
);

export const LABEL_FINDING = {
    path: "src/a.ts",
    line: 1,
    label: "issue (blocking)",
    failure_scenario: "with input X the constant is wrong and Y crashes.",
    subject: "Constant changed incorrectly",
    discussion: "The new value breaks the Y invariant.",
};

export const SCHEMA_FINDING = {
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

/**
 * A scripted runner: outputs queued per agent name, requests recorded. With
 * `usage`, every call also reports that token usage (the SDK's modelUsage).
 */
export const scriptedRunner = (
    scripts: Record<string, string[]>,
    usage?: ModelTokens[],
): {runner: LiveAgentRunner; requests: LiveAgentRequest[]} => {
    const requests: LiveAgentRequest[] = [];
    const cursors: Record<string, number> = {};
    const runner: LiveAgentRunner = async (request) => {
        requests.push(request);
        const queue = scripts[request.name] ?? [];
        const cursor = cursors[request.name] ?? 0;
        cursors[request.name] = cursor + 1;
        const output = queue[Math.min(cursor, queue.length - 1)] ?? "{}";
        return {
            output,
            usd: 0.25,
            turns: 3,
            wallMs: 1000,
            ...(usage === undefined ? {} : {usage}),
        };
    };
    return {runner, requests};
};

export const validatorOutput = (
    entries: {id: string; verification: string; confidence?: number}[],
): string =>
    JSON.stringify({
        claims: entries.map((entry) => ({...entry, reason: "checked"})),
    });
