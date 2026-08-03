import {describe, it, expect} from "vitest";

import {
    checkConsumerConfig,
    CONFIG_IMPORT_PATH,
    INSTALLED_LOCK_PATH,
    INSTALLED_WORKFLOW_PATH,
    parseArgs,
    REQUIRED_RUNTIME_IMPORTS,
    renderReport,
} from "./check-consumer-config.ts";
import type {FsLike} from "./check-consumer-config.ts";
import {ROUTING_CONFIG_PATH} from "./routing-config.ts";

/**
 * Consumer-config checker tests. Each case is one way an install fails silently
 * in production; the whole point of the checker is that none of these surfaces
 * at `gh aw compile` time, so the test is the only place they are pinned besides
 * a real PR going wrong.
 *
 * Routing semantics themselves are NOT re-tested here (router.test.ts owns
 * those); what these assert is that the checker asks the real router and reports
 * its answer, so the tier assertions below are deliberately thin.
 */

/** In-memory fs. A directory "exists" when some key sits beneath it. */
const fakeFs = (inputs: Record<string, string>): FsLike => ({
    readFileSync: (p: string): string => {
        const content = inputs[p];
        if (content === undefined) {
            throw new Error(`unexpected read: ${p}`);
        }
        return content;
    },
    existsSync: (p: string): boolean =>
        p in inputs ||
        Object.keys(inputs).some((key) => key.startsWith(`${p}/`)),
    readdirSync: (p: string): string[] => {
        if (p in inputs) {
            throw new Error(`ENOTDIR: not a directory, scandir '${p}'`);
        }
        return Object.keys(inputs)
            .filter((key) => key.startsWith(`${p}/`))
            .map((key) => key.slice(p.length + 1).split("/")[0]);
    },
});

const WORKFLOW_MD = `---
imports:
  - ${CONFIG_IMPORT_PATH}
permissions:
  contents: read
safe-outputs:
  submit-pull-request-review:
    max: 1
max-ai-credits: 2500
source: Khan/actions/workflows/review/review.md@review-v1.11.0
---

Prompt body.
`;

const CONFIG_MD = `---
safe-outputs:
  add-reviewer:
    target: "triggering"
    max: 2
    allowed-team-reviewers:
      - kore
    github-token: \${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}
---
`;

// Realistic ordering: the broad docs rule first, its executable-prose
// exceptions after it (last matching rule wins).
const ROUTING = `enable holistic,completeness
re-review scoped
**/*.md                      tier=trivial
plugins/**                   tier=high
plugins/*/skills/*/SKILL.md  tier=high
.github/workflows/**         tier=high
.github/workflows/*.md       tier=high
.github/aw/review/**         tier=high
`;

/** A fully valid install: every later case mutates one thing out of this. */
const validInstall = (): Record<string, string> => ({
    [INSTALLED_WORKFLOW_PATH]: WORKFLOW_MD,
    [INSTALLED_LOCK_PATH]: "# compiled\n",
    [CONFIG_IMPORT_PATH]: CONFIG_MD,
    [REQUIRED_RUNTIME_IMPORTS[0]]: "### High Risk\n\n- plugins/**\n",
    [REQUIRED_RUNTIME_IMPORTS[1]]: "- **Lint**: eslint.\n",
    [REQUIRED_RUNTIME_IMPORTS[2]]: "### conventions - `README.md`\n",
    [ROUTING_CONFIG_PATH]: ROUTING,
    ".gitattributes": ".github/workflows/*.lock.yml linguist-generated=true\n",
});

const codes = (
    report: ReturnType<typeof checkConsumerConfig>,
    severity: "error" | "warning",
): string[] =>
    report.issues
        .filter((issue) => issue.severity === severity)
        .map((issue) => issue.code);

const check = (
    inputs: Record<string, string>,
    options: Parameters<typeof checkConsumerConfig>[1] = {},
) => checkConsumerConfig(fakeFs(inputs), options);

describe("a valid install", () => {
    it("reports no errors and reads the install back", () => {
        const report = check(validInstall(), {checkerVersion: "1.11.0"});
        expect(codes(report, "error")).toEqual([]);
        expect(codes(report, "warning")).toEqual([]);
        expect(report.installedWorkflow.pinnedRef).toBe("review-v1.11.0");
        expect(report.installedWorkflow.maxAiCredits).toBe(2500);
        expect(report.installedWorkflow.observabilityActive).toBe(false);
        expect(report.reviewerRouting.allowedTeamReviewers).toEqual(["kore"]);
        expect(report.reviewerRouting.hasGithubToken).toBe(true);
        expect(report.routing.enabledReviewers).toEqual([
            "holistic",
            "completeness",
        ]);
        expect(report.routing.reReviewMode).toBe("scoped");
    });

    it("renders a PASS line", () => {
        const rendered = renderReport(
            check(validInstall(), {checkerVersion: "1.11.0"}),
        );
        expect(rendered).toContain("PASS with 0 warning(s).");
    });
});

describe("required config files", () => {
    it("errors once per missing file, naming when it would fail", () => {
        const report = check({});
        expect(codes(report, "error")).toEqual([
            "missing-required-config",
            "missing-required-config",
            "missing-required-config",
            "missing-required-config",
            "workflow-not-installed",
        ]);
        const compileTime = report.issues.find((issue) =>
            issue.message.startsWith(CONFIG_IMPORT_PATH),
        );
        expect(compileTime?.message).toContain("gh aw compile");
    });

    it("errors on an empty required file", () => {
        const inputs = validInstall();
        inputs[REQUIRED_RUNTIME_IMPORTS[2]] = "\n  \n";
        expect(codes(check(inputs), "error")).toEqual([
            "empty-required-config",
        ]);
    });

    it("errors on a template expression inside a runtime import", () => {
        const inputs = validInstall();
        inputs[
            REQUIRED_RUNTIME_IMPORTS[1]
        ] = `- Lint runs on \${{ github.sha }}\n`;
        expect(codes(check(inputs), "error")).toEqual([
            "template-expression-in-import",
        ]);
    });

    it("exempts config.md, whose bot token is a template expression by design", () => {
        // CONFIG_MD carries ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }} and is a
        // frontmatter import, not a runtime one.
        expect(codes(check(validInstall()), "error")).toEqual([]);
    });

    it("flags a template expression in a lens payload", () => {
        const inputs = validInstall();
        inputs[".github/aw/review/lenses/security-auth.md"] =
            "- check ${{ secrets.FOO }}\n";
        expect(codes(check(inputs), "error")).toEqual([
            "template-expression-in-import",
        ]);
    });
});

describe("the add-reviewer contract", () => {
    it("errors when the main workflow defines add-reviewer too", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "  submit-pull-request-review:\n    max: 1\n",
            "  add-reviewer:\n    max: 2\n",
        );
        expect(codes(check(inputs), "error")).toEqual([
            "workflow-defines-add-reviewer",
        ]);
    });

    it("errors when the workflow drops the config import", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            `imports:\n  - ${CONFIG_IMPORT_PATH}\n`,
            "",
        );
        expect(codes(check(inputs), "error")).toEqual([
            "workflow-missing-config-import",
        ]);
    });

    it("errors on an empty team allowlist", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    allowed-team-reviewers:\n      - kore\n",
            "",
        );
        expect(codes(check(inputs), "error")).toEqual([
            "config-empty-team-allowlist",
        ]);
    });

    it("errors when config.md carries no add-reviewer at all", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] =
            "---\nsafe-outputs:\n  add-comment:\n---\n";
        expect(codes(check(inputs), "error")).toEqual([
            "config-missing-add-reviewer",
        ]);
    });

    it("warns when add-reviewer names no bot token", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}\n",
            "",
        );
        expect(codes(check(inputs), "warning")).toEqual([
            "config-no-bot-token",
        ]);
    });
});

describe("the compiled lock", () => {
    it("errors when the lock is missing (nothing runs)", () => {
        const inputs = validInstall();
        delete inputs[INSTALLED_LOCK_PATH];
        expect(codes(check(inputs), "error")).toEqual(["lock-missing"]);
    });

    it("warns when the lock is not marked linguist-generated", () => {
        const inputs = validInstall();
        delete inputs[".gitattributes"];
        expect(codes(check(inputs), "warning")).toEqual([
            "lock-not-marked-generated",
        ]);
    });
});

describe("the pinned source", () => {
    it("warns when the install tracks a branch instead of a tag", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "@review-v1.11.0",
            "",
        );
        expect(codes(check(inputs), "warning")).toEqual(["source-unpinned"]);
    });

    it("warns when the checker's own version is not the pinned one", () => {
        const report = check(validInstall(), {checkerVersion: "1.12.0"});
        expect(codes(report, "warning")).toEqual(["source-ref-mismatch"]);
    });

    it("stays quiet about the version when the checker does not know its own", () => {
        expect(codes(check(validInstall()), "warning")).toEqual([]);
    });
});

describe("local edits the README prescribes", () => {
    it("warns when the observability block is live", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "max-ai-credits: 2500\n",
            "observability:\n  otlp:\n    exporters: []\nmax-ai-credits: 2500\n",
        );
        expect(codes(check(inputs), "warning")).toEqual([
            "observability-active",
        ]);
    });

    it("warns when max-ai-credits is still the shipped ceiling", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "max-ai-credits: 2500",
            "max-ai-credits: 1000",
        );
        expect(codes(check(inputs), "warning")).toEqual([
            "max-ai-credits-default",
        ]);
    });
});

describe("ROUTING", () => {
    it("warns when absent, and does not then nag about tiers it cannot know", () => {
        const inputs = validInstall();
        delete inputs[ROUTING_CONFIG_PATH];
        const warnings = codes(check(inputs), "warning");
        expect(warnings).toContain("routing-missing");
        expect(warnings).not.toContain("reviewer-config-not-high");
    });

    it("forwards the real parser's warnings", () => {
        const inputs = validInstall();
        inputs[ROUTING_CONFIG_PATH] = `${ROUTING}src/** lens=not-a-lens\n`;
        const report = check(inputs);
        expect(codes(report, "warning")).toContain("routing-parse-warning");
        expect(
            report.issues.find(
                (issue) => issue.code === "routing-parse-warning",
            )?.message,
        ).toContain("not-a-lens");
    });

    it("warns when no opt-in reviewer is enabled and the mode is still full", () => {
        const inputs = validInstall();
        inputs[ROUTING_CONFIG_PATH] = ".github/aw/review/** tier=high\n";
        const warnings = codes(check(inputs), "warning");
        expect(warnings).toContain("no-enabled-reviewers");
        expect(warnings).toContain("re-review-full");
    });

    it("warns when the reviewer's own config does not route to high", () => {
        const inputs = validInstall();
        inputs[ROUTING_CONFIG_PATH] = "enable holistic\nre-review scoped\n";
        const report = check(inputs);
        expect(codes(report, "warning")).toContain("reviewer-config-not-high");
        expect(report.configFileTiers[ROUTING_CONFIG_PATH]).toBe("low");
    });
});

describe("tier preview", () => {
    // Every pattern in ROUTING matches at least one of these, so a dead pattern
    // in a later case is the case's own doing. This is the shape of the real
    // invocation: the whole tracked set, from `git ls-files`.
    const files = [
        "plugins/kore/skills/support/SKILL.md",
        "plugins/kore/scripts/run.py",
        "README.md",
        "docs/notes.md",
        ".github/workflows/review.md",
        ".github/workflows/review.lock.yml",
        ".github/aw/review/ROUTING",
        "Makefile",
    ];

    it("counts tiers from the real router and lists rule-less files", () => {
        const report = check(validInstall(), {files});
        const preview = report.tierPreview;
        expect(preview?.fileCount).toBe(8);
        // The lock is linguist-generated, so it is classified, not tiered.
        expect(preview?.generated).toBe(1);
        expect(preview?.counts.high).toBe(4);
        expect(preview?.counts.trivial).toBe(2);
        // Only the file no `tier=` rule matches at all.
        expect(preview?.unmatched).toEqual(["Makefile"]);
        expect(preview?.deadPatterns).toEqual([]);
        expect(codes(report, "warning")).toEqual(["files-without-tier-rule"]);
    });

    it("names patterns that match nothing, typo or not", () => {
        const inputs = validInstall();
        // `plugin/**` is a plausible typo for `plugins/**`, and the misspelling
        // parses perfectly: only the file list reveals that it routes nothing.
        inputs[ROUTING_CONFIG_PATH] = `${ROUTING}plugin/** tier=high\n`;
        const report = check(inputs, {files});
        expect(report.tierPreview?.deadPatterns).toEqual(["plugin/**"]);
        expect(codes(report, "warning")).toContain(
            "routing-pattern-matches-nothing",
        );
        expect(renderReport(report)).toContain(
            "dead patterns (match nothing): plugin/**",
        );
    });

    it("treats a no-slash pattern as a basename match, and a leading slash as root-anchored", () => {
        // `notes.md` (no slash) matches the basename in ANY directory, while
        // `/notes.md` matches only the root file. Pinned here because Step 4 of
        // the onboarding skill tells authors to rely on both.
        const anchored = validInstall();
        anchored[ROUTING_CONFIG_PATH] = `${ROUTING}/notes.md tier=high\n`;
        // No root notes.md in the file list, so the anchored rule is dead...
        expect(check(anchored, {files}).tierPreview?.deadPatterns).toEqual([
            "/notes.md",
        ]);
        // ...and the nested file it looks like it names keeps its docs tier.
        expect(
            check(anchored, {explainPath: "docs/notes.md"}).explanation?.tier,
        ).toBe("trivial");

        const bare = validInstall();
        bare[ROUTING_CONFIG_PATH] = `${ROUTING}notes.md tier=high\n`;
        expect(check(bare, {files}).tierPreview?.deadPatterns).toEqual([]);
        expect(
            check(bare, {explainPath: "docs/notes.md"}).explanation?.tier,
        ).toBe("high");
    });

    it("is absent when no file list is supplied", () => {
        expect(check(validInstall()).tierPreview).toBeUndefined();
    });
});

describe("explain", () => {
    it("lists every matching rule in file order, last one winning", () => {
        const report = check(validInstall(), {
            explainPath: "plugins/kore/skills/support/SKILL.md",
        });
        expect(report.explanation?.tier).toBe("high");
        expect(
            report.explanation?.matchingTierRules.map((rule) => rule.pattern),
        ).toEqual(["**/*.md", "plugins/**", "plugins/*/skills/*/SKILL.md"]);
        expect(renderReport(report)).toContain("rules   (last one wins)");
    });

    it("reports a generated file as generated", () => {
        const report = check(validInstall(), {
            explainPath: ".github/workflows/review.lock.yml",
        });
        expect(report.explanation?.generated).toBe(true);
        expect(report.explanation?.tier).toBe("trivial");
    });
});

describe("leftover scaffolding", () => {
    it("warns about the gh aw init Copilot files", () => {
        const inputs = validInstall();
        inputs[".github/mcp.json"] = "{}\n";
        inputs[".github/agents/example.md"] = "# agent\n";
        const report = check(inputs);
        expect(codes(report, "warning")).toEqual([
            "copilot-scaffolding-present",
        ]);
        expect(
            report.issues.find(
                (issue) => issue.code === "copilot-scaffolding-present",
            )?.message,
        ).toContain(".github/mcp.json, .github/agents");
    });
});

describe("parseArgs", () => {
    it("reads the flags the CLI documents", () => {
        expect(
            parseArgs([
                "--repo",
                "../consumer",
                "--files-from",
                "-",
                "--explain",
                "src/a.ts",
                "--json",
                "--strict",
            ]),
        ).toEqual({
            repoRoot: "../consumer",
            filesFrom: "-",
            explainPath: "src/a.ts",
            json: true,
            strict: true,
        });
    });

    it("rejects an unknown flag rather than ignoring it", () => {
        expect(() => parseArgs(["--nope"])).toThrow("unknown argument: --nope");
    });
});
