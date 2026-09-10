import {existsSync, mkdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {
    applyVerifications,
    buildClaims,
    parseJsonObject,
    parseValidatorOutput,
    type Claim,
} from "../lib/dispatch-contracts";
import {isBlockingLabel} from "../lib/render-comment";
import {renderClaimComment} from "../lib/submission-render";
import {extractAgents} from "./agent-extract";
import {scoreFidelity, type FidelityFixture} from "./claim-fidelity";
import {
    resolveRuntimeImports,
    type LiveAgentResult,
    type LiveAgentRunner,
} from "./live-producer";
import {rewriteAgentPrompt} from "./live-stage";
import {READ_TOOL_POLICY} from "./read-scope";
import {CLAIM_RENDERING_FILES, hashFiles} from "./fidelity-provenance";
import {
    sha256,
    stageValidatorCase,
    type Snapshot,
} from "./validator-fidelity-stage";

export type SampleKind = "original" | "clean-control";

/** Request preparation, execution, accounting, scoring, and posting dependencies. */
export const VALIDATOR_IMPLEMENTATION_FILES = [
    "workflows/review/eval/fidelity-provenance.ts",
    "workflows/review/eval/validator-fidelity.ts",
    "workflows/review/eval/validator-fidelity-stage.ts",
    "workflows/review/eval/validator-fidelity-live.ts",
    "workflows/review/eval/claim-fidelity.ts",
    "workflows/review/eval/corpus/loader.ts",
    "workflows/review/eval/agent-extract.ts",
    "workflows/review/eval/extract-json.ts",
    "workflows/review/eval/live-producer.ts",
    "workflows/review/eval/live-stage.ts",
    "workflows/review/eval/live-runner.ts",
    "workflows/review/eval/live-agent-error.ts",
    "workflows/review/eval/read-scope.ts",
    "workflows/review/eval/transcripts.ts",
    "workflows/review/lib/pricing.ts",
    ...CLAIM_RENDERING_FILES,
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
];

export const inputClaim = (
    fixture: FidelityFixture,
    kind: SampleKind,
): Claim => {
    const claims = buildClaims(fixture.corpusCase.findings);
    const selected =
        kind === "original"
            ? claims
            : applyVerifications(
                  claims,
                  parseValidatorOutput(JSON.stringify(fixture.control)),
              );
    if (selected.length !== 1) {
        throw new Error("Expected exactly one input claim");
    }
    // No thread id, expected verdict, or original/control label reaches the model.
    return {...selected[0], id: "candidate-1"};
};

export const scoreValidatorOutput = (
    fixture: FidelityFixture,
    claim: Claim,
    output: string,
) => {
    // Extract once with production's rule so the duplicate guard and verdict
    // parser cannot select different objects from the same output.
    const raw = parseJsonObject(output) as {claims?: {id?: string}[]};
    const verdicts = parseValidatorOutput(JSON.stringify(raw));
    // Unlike production's fail-open path, an omitted/invalid result is an eval
    // error, not a successful retention. Reject duplicate ids before scoring.
    if (
        raw.claims?.length !== 1 ||
        raw.claims[0].id !== claim.id ||
        Object.keys(verdicts).length !== 1 ||
        verdicts[claim.id] === undefined
    ) {
        throw new Error(
            "Expected exactly one valid verification for candidate-1",
        );
    }
    const surviving = applyVerifications([claim], verdicts);
    const body =
        surviving[0] === undefined
            ? undefined
            : renderClaimComment(surviving[0]);
    return {
        verification: verdicts[claim.id].verification,
        retained: surviving.length === 1,
        unexpectedBlocking: surviving.some((c) => isBlockingLabel(c.label)),
        facets: scoreFidelity(body, fixture.checks),
        body,
    };
};

type Sample = {
    caseId: string;
    kind: SampleKind;
    repeat: number;
    status: "scored" | "error" | "skipped";
    stage?: string;
    inputSha256?: string;
    resolvedPromptSha256?: string;
    result?: LiveAgentResult;
    score?: ReturnType<typeof scoreValidatorOutput>;
    error?: string;
};

export type ValidatorFidelityReport = {
    model: string;
    promptSha256: string;
    scorerSha256: string;
    implementationFiles: string[];
    implementationSha256: string;
    inputsSha256: string;
    toolPolicy: string;
    scope: string;
    maxUsd: number;
    budgetPolicy: string;
    spentUsd: number;
    spendComplete: boolean;
    samples: Sample[];
};

export const runValidatorFidelity = async (
    fixtures: FidelityFixture[],
    snapshots: Snapshot[],
    reviewMd: string,
    options: {
        sourceRoot: string;
        stageRoot: string;
        runner: LiveAgentRunner;
        repeats: number;
        maxUsd: number;
        checkpoint: (report: ValidatorFidelityReport) => void;
    },
): Promise<ValidatorFidelityReport> => {
    if (
        !Number.isInteger(options.repeats) ||
        options.repeats < 1 ||
        options.repeats > 20 ||
        !Number.isFinite(options.maxUsd) ||
        options.maxUsd <= 0
    ) {
        throw new Error(
            "Expected repeats in 1..20 and a positive spend threshold",
        );
    }
    const agent = extractAgents(reviewMd).get("claim-validator");
    if (agent === undefined) {
        throw new Error("Missing claim-validator prompt");
    }
    const inputs = fixtures.flatMap((f) => [
        inputClaim(f, "original"),
        inputClaim(f, "clean-control"),
    ]);
    const report: ValidatorFidelityReport = {
        model: agent.model,
        promptSha256: sha256(agent.prompt),
        scorerSha256: sha256(
            readFileSync("workflows/review/eval/claim-fidelity.ts"),
        ),
        implementationFiles: [...VALIDATOR_IMPLEMENTATION_FILES],
        implementationSha256: hashFiles(VALIDATOR_IMPLEMENTATION_FILES),
        inputsSha256: sha256(
            JSON.stringify({
                snapshots,
                inputs,
                checks: fixtures.map((f) => f.checks),
            }),
        ),
        toolPolicy: READ_TOOL_POLICY,
        scope: "Validator-only partial checkout replay. No original PR metadata, skills, or investigation-cap CLI. Lexical scores require manual audit.",
        maxUsd: options.maxUsd,
        budgetPolicy:
            "Stop before the next dispatch at the spend threshold. An in-flight call may overrun it. Stop on an unpriced failure.",
        spentUsd: 0,
        spendComplete: true,
        samples: [],
    };
    options.checkpoint(report);
    mkdirSync(options.stageRoot, {recursive: true});
    let stopped = false;
    for (let repeat = 1; repeat <= options.repeats; repeat++) {
        for (const fixture of fixtures) {
            // Alternate presentation order across repeats without changing inputs.
            const kinds: SampleKind[] =
                repeat % 2 === 1
                    ? ["original", "clean-control"]
                    : ["clean-control", "original"];
            for (const kind of kinds) {
                const sample: Sample = {
                    caseId: fixture.corpusCase.id,
                    kind,
                    repeat,
                    status: "skipped",
                };
                report.samples.push(sample);
                if (stopped || report.spentUsd >= options.maxUsd) {
                    sample.error = stopped
                        ? "Stopped after an unpriced failure"
                        : "Spend threshold reached";
                    options.checkpoint(report);
                    continue;
                }
                const snapshot = snapshots.find(
                    (s) => s.caseId === fixture.corpusCase.id,
                );
                if (
                    snapshot === undefined ||
                    snapshot.reviewedCommit !==
                        fixture.provenance.reviewedCommit
                ) {
                    throw new Error(
                        `Missing pinned snapshot: ${fixture.corpusCase.id}`,
                    );
                }
                const claim = inputClaim(fixture, kind);
                const root = join(
                    options.stageRoot,
                    `sample-${report.samples.length}`,
                );
                mkdirSync(root, {recursive: false});
                const staged = stageValidatorCase(
                    options.sourceRoot,
                    snapshot,
                    claim,
                    root,
                );
                const prompt = rewriteAgentPrompt(
                    resolveRuntimeImports(agent.prompt, staged.checkoutDir, {
                        existsSync,
                        readFileSync,
                    }),
                    staged,
                );
                sample.stage = root;
                sample.inputSha256 = sha256(JSON.stringify(claim));
                sample.resolvedPromptSha256 = sha256(prompt);
                sample.status = "error";
                try {
                    const result = await options.runner({
                        name: agent.name,
                        model: agent.model,
                        prompt,
                        cwd: staged.checkoutDir,
                        readRoot: root,
                        maxTurns: 12,
                        timeoutMs: 180_000,
                    });
                    sample.result = result;
                    // The SDK runner uses zero for missing pricing. It isn't
                    // evidence of a free call, so stop rather than undercount.
                    if (!Number.isFinite(result.usd) || result.usd <= 0) {
                        throw new Error("Runner returned no usable cost");
                    }
                    report.spentUsd += result.usd;
                } catch (error) {
                    sample.error = String(error);
                    report.spendComplete = false;
                    stopped = true;
                    options.checkpoint(report);
                    continue;
                }
                try {
                    sample.score = scoreValidatorOutput(
                        fixture,
                        claim,
                        sample.result.output,
                    );
                    sample.status = "scored";
                } catch (error) {
                    sample.error = String(error);
                }
                options.checkpoint(report);
            }
        }
    }
    return report;
};
