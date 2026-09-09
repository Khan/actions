import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";

const workflow = readFileSync(".github/workflows/review-eval-ab.yml", "utf8");
const step = workflow
    .split("      - name: Run the live A/B\n")[1]
    ?.split("      - name: Upload the report artifact\n")[0];
const script = step?.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");

// Execute the workflow's shell, but replace pnpm before it can launch a model.
const workflowArgs = (overrides: Record<string, string> = {}): string[] => {
    if (script === undefined) {
        throw new Error("Live A/B workflow step not found");
    }
    return execFileSync(
        "bash",
        ["-e", "-c", `pnpm() { printf '%s\\n' "$@"; }\n${script}`],
        {
            encoding: "utf8",
            env: {
                PATH: process.env["PATH"],
                ANTHROPIC_API_KEY: "test-only-pnpm-is-stubbed",
                BASE_REF: "origin/main",
                FULL_EVAL: "false",
                MAX_USD: "",
                CASES: "",
                REPEATS: "1",
                FORCE_ARMS: "false",
                RUNNER_TEMP: "/unused-test-transcripts",
                ...overrides,
            },
        },
    )
        .trim()
        .split("\n");
};

const budget = (args: string[]): string | undefined =>
    args[args.indexOf("--max-usd") + 1];

describe("live A/B workflow budget", () => {
    it("leaves an omitted dispatch budget empty until scope is known", () => {
        expect(workflow).toMatch(/max_usd:\n(?:.*\n)*? {8}default: ""/);
        expect(step).toContain("MAX_USD: ${{ inputs.max_usd || '' }}");
        expect(step).toContain(
            "FULL_EVAL: ${{ inputs.full == true || contains(github.event.pull_request.labels.*.name, 'full-eval') }}",
        );
    });

    it.each([
        ["false", "", "40"],
        ["true", "", "200"],
        ["false", "75", "75"],
        ["true", "75", "75"],
    ])("full=%s override=%s uses %s USD", (full, override, expected) => {
        const args = workflowArgs({FULL_EVAL: full, MAX_USD: override});
        expect(budget(args)).toBe(expected);
        expect(args.includes("--smoke-only")).toBe(full !== "true");
        expect(args).not.toContain("--include-reserved-holdout");
    });

    it("keeps the full budget total across repeats and preserves case selection", () => {
        const args = workflowArgs({
            FULL_EVAL: "true",
            REPEATS: "3",
            CASES: "case-a,case-b",
        });
        expect(budget(args)).toBe("200");
        expect(args[args.indexOf("--repeats") + 1]).toBe("3");
        expect(args[args.indexOf("--cases") + 1]).toBe("case-a,case-b");
    });

    it("does not dispatch without credentials", () => {
        const args = workflowArgs({ANTHROPIC_API_KEY: ""});
        expect(args).not.toContain("dlx");
    });
});
