import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

import {extractAgents} from "./agent-extract";

const markdown = readFileSync("workflows/review/review.md", "utf8");
const workflow = readFileSync(".github/workflows/review-eval-ab.yml", "utf8");

const step = (name: string): string => {
    const body = workflow.split(`      - name: ${name}\n`)[1];
    if (body === undefined) {
        throw new Error(`missing workflow step ${name}`);
    }
    return body.split("\n      - ")[0];
};

const runStep = (
    name: string,
    anthropic: string,
    openai: string,
    baselineModel = "claude-opus-5",
    gemini = "",
): string => {
    const script = step(name).split("        run: |\n")[1];
    if (script === undefined) {
        throw new Error(`missing script in ${name}`);
    }
    const result = spawnSync(
        "bash",
        [
            "-eu",
            "-c",
            [
                // Intercept the only executable entry point. No model call occurs.
                'pnpm() { printf "invoked: %s\\n" "$*"; }',
                'git() { printf "model: %s\\n" "$BASELINE_MODEL"; }',
                script.replace(/^ {10}/gm, ""),
            ].join("\n"),
        ],
        {
            encoding: "utf8",
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: anthropic,
                OPENAI_API_KEY: openai,
                GEMINI_API_KEY: gemini,
                BASELINE_MODEL: baselineModel,
                PROBES_ONLY: "false",
                SMOKE_CASE: "",
                FULL_EVAL: "false",
                CASES: "",
                REPEATS: "1",
                FORCE_ARMS: "false",
                BASE_REF: "origin/main",
                MAX_USD: "40",
            },
        },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout + result.stderr;
};

describe("astra eval configuration", () => {
    it("pins all 23 candidate sub-agents to astra, not the engine", () => {
        const agents = [...extractAgents(markdown).values()];
        expect(agents).toHaveLength(23);
        expect(new Set(agents.map((agent) => agent.model))).toEqual(
            new Set(["gpt-6-astra"]),
        );
        expect(markdown).toMatch(/^ {2}model: claude-opus-5$/m);
    });

    it("supplies both API secrets to the A/B and live sandbox steps", () => {
        for (const name of ["Run the live A/B", "Run the sandbox smoke"]) {
            expect(step(name)).toContain(
                "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
            );
            expect(step(name)).toContain(
                "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
            );
        }
    });

    it.each([
        ["", "test"],
        ["test", ""],
        ["", ""],
    ])(
        "does not spend on either arm without both keys (%s, %s)",
        (anthropic, openai) => {
            const output = runStep("Run the live A/B", anthropic, openai);
            expect(output).not.toContain("invoked:");
            expect(output).toMatch(/not configured/);
            const smoke = runStep("Run the sandbox smoke", anthropic, openai);
            expect(smoke).toContain("sandbox-smoke.ts --probes-only");
        },
    );

    it("runs the A/B and live smoke when both keys are present", () => {
        expect(runStep("Run the live A/B", "test", "test")).toContain(
            "live-ab.ts --base-ref origin/main --max-usd 40 --smoke-only",
        );
        const smoke = runStep("Run the sandbox smoke", "test", "test");
        expect(smoke).toContain("sandbox-smoke.ts");
        expect(smoke).not.toContain("--probes-only");
    });

    it("skips a gemini baseline before spending without its key", () => {
        const output = runStep(
            "Run the live A/B",
            "test",
            "test",
            "gemini-3.8-flash",
        );
        expect(output).toContain("GEMINI_API_KEY not configured");
        expect(output).not.toContain("invoked:");
    });

    it("supports a stacked gemini baseline when its key is present", () => {
        expect(step("Run the live A/B")).toContain(
            "GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}",
        );
        const output = runStep(
            "Run the live A/B",
            "test",
            "test",
            "gemini-3.8-flash",
            "test",
        );
        expect(output).toContain("live-ab.ts");
    });

    it("captures transcripts automatically for PR trials", () => {
        expect(step("Run the live A/B")).toContain(
            "REVIEW_EVAL_TRANSCRIPTS: ${{ (github.event_name == 'pull_request' || inputs.transcripts == true) && '1' || '' }}",
        );
    });
});
