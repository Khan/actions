import {describe, it, expect} from "vitest";

import {
    BETA_LOCK_PATH,
    BETA_WORKFLOW_PATH,
    betaGates,
    betaInstallIssues,
    lockWorkflowName,
    workflowCondition,
} from "./beta-install.ts";
import {
    INSTALLED_LOCK_PATH,
    INSTALLED_WORKFLOW_PATH,
} from "./check-consumer-config.ts";
import type {ConsumerConfigFs} from "./check-consumer-config.ts";

const fakeFs = (inputs: Record<string, string>): ConsumerConfigFs => ({
    readFileSync: (p: string): string => {
        const content = inputs[p];
        if (content === undefined) {
            throw new Error(`unexpected read: ${p}`);
        }
        return content;
    },
    existsSync: (p: string): boolean => p in inputs,
    readdirSync: (): string[] => [],
});

const GATE =
    "contains(fromJSON(vars.REVIEW_BETA_AUTHORS || '[]'), github.event.pull_request.user.login || github.event.issue.user.login)";

const workflow = (condition: string, ref: string, extraOn = ""): string => `---
on:
  pull_request:
    types: [opened, synchronize]
${extraOn}if: >-
  !startsWith(github.event.pull_request.head.ref, 'deploy/') &&
  ${condition}
source: Khan/actions/workflows/review/review.md@${ref}
---

# PR Reviewer
`;

const lock = (name: string): string =>
    `# generated\n\nname: "${name}"\non:\n  pull_request: {}\n`;

const pair = (): Record<string, string> => ({
    [INSTALLED_WORKFLOW_PATH]: workflow(`!${GATE}`, "review-v1.26.0"),
    [INSTALLED_LOCK_PATH]: lock("PR Reviewer"),
    [BETA_WORKFLOW_PATH]: workflow(GATE, "review-v2.0.0"),
    [BETA_LOCK_PATH]: lock("PR Reviewer (beta)"),
});

const run = (inputs: Record<string, string>) =>
    betaInstallIssues(fakeFs(inputs), (p) => p, {
        path: INSTALLED_WORKFLOW_PATH,
        lockPath: INSTALLED_LOCK_PATH,
    });

const codes = (inputs: Record<string, string>): string[] =>
    run(inputs).map((issue) => `${issue.severity}:${issue.code}`);

describe("workflowCondition", () => {
    it("joins a folded block scalar", () => {
        expect(workflowCondition("if: >-\n  a &&\n  b\nimports:\n  - x")).toBe(
            "a && b",
        );
    });

    it("unquotes an inline condition", () => {
        expect(workflowCondition(`if: "a && b"\non: {}`)).toBe("a && b");
    });

    it("is undefined without an if", () => {
        expect(workflowCondition("on: {}")).toBeUndefined();
    });
});

describe("betaGates", () => {
    it("reads polarity, guard, and author", () => {
        expect(
            betaGates(
                `x && !${GATE} || contains(fromJSON(vars.REVIEW_BETA_AUTHORS), github.event.pull_request.user.login)`,
            ),
        ).toEqual([
            {
                negated: true,
                guarded: true,
                author: "github.event.pull_request.user.login || github.event.issue.user.login",
            },
            {
                negated: false,
                guarded: false,
                author: "github.event.pull_request.user.login",
            },
        ]);
    });
});

describe("lockWorkflowName", () => {
    it("reads the top-level name", () => {
        expect(lockWorkflowName(lock("PR Reviewer (beta)"))).toBe(
            "PR Reviewer (beta)",
        );
    });
});

describe("betaInstallIssues", () => {
    it("reports nothing without a beta install", () => {
        const inputs = pair();
        delete inputs[BETA_WORKFLOW_PATH];
        expect(codes(inputs)).toEqual([]);
    });

    it("reports nothing for a correct pair", () => {
        expect(codes(pair())).toEqual([]);
    });

    it("flags a stable install that does not exclude beta authors", () => {
        const inputs = pair();
        inputs[INSTALLED_WORKFLOW_PATH] = workflow("true", "review-v1.26.0");
        expect(codes(inputs)).toEqual(["error:beta-gate-missing"]);
    });

    it("flags a beta install that does not select beta authors", () => {
        const inputs = pair();
        inputs[BETA_WORKFLOW_PATH] = workflow("true", "review-v2.0.0");
        expect(codes(inputs)).toEqual(["error:beta-gate-missing"]);
    });

    it("flags matching polarity", () => {
        const inputs = pair();
        inputs[BETA_WORKFLOW_PATH] = workflow(`!${GATE}`, "review-v2.0.0");
        expect(codes(inputs)).toEqual(["error:beta-gate-polarity"]);
    });

    it("flags a fromJSON with no empty-variable guard", () => {
        const inputs = pair();
        inputs[BETA_WORKFLOW_PATH] = workflow(
            GATE.replace(" || '[]'", ""),
            "review-v2.0.0",
        );
        expect(codes(inputs)).toEqual(["error:beta-gate-unguarded"]);
    });

    it("flags a comment-triggered install that reads only pull_request.user.login", () => {
        const inputs = pair();
        inputs[INSTALLED_WORKFLOW_PATH] = workflow(
            `!${GATE.replace(" || github.event.issue.user.login", "")}`,
            "review-v1.26.0",
            "  issue_comment:\n    types: [created]\n",
        );
        expect(codes(inputs)).toEqual(["error:beta-gate-author"]);
    });

    it("accepts pull_request.user.login alone without a comment trigger", () => {
        const inputs = pair();
        inputs[INSTALLED_WORKFLOW_PATH] = workflow(
            `!${GATE.replace(" || github.event.issue.user.login", "")}`,
            "review-v1.26.0",
        );
        expect(codes(inputs)).toEqual([]);
    });

    it("flags equal workflow names", () => {
        const inputs = pair();
        inputs[BETA_LOCK_PATH] = lock("PR Reviewer");
        expect(codes(inputs)).toEqual(["error:beta-name-collision"]);
    });

    it("flags a missing beta lock", () => {
        const inputs = pair();
        delete inputs[BETA_LOCK_PATH];
        expect(codes(inputs)).toEqual(["error:beta-lock-missing"]);
    });

    it("flags a beta with no stable install", () => {
        const inputs = pair();
        delete inputs[INSTALLED_WORKFLOW_PATH];
        delete inputs[INSTALLED_LOCK_PATH];
        expect(codes(inputs)).toEqual(["error:beta-without-stable"]);
    });

    it("warns when both installs pin the same release", () => {
        const inputs = pair();
        inputs[BETA_WORKFLOW_PATH] = workflow(GATE, "review-v1.26.0");
        expect(codes(inputs)).toEqual(["warning:beta-same-pin"]);
    });
});
