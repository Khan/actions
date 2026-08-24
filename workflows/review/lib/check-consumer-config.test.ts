import {describe, it, expect} from "vitest";

import {
    checkConsumerConfig,
    CONFIG_IMPORT_PATH,
    INSTALLED_LOCK_PATH,
    INSTALLED_WORKFLOW_PATH,
    MAINTENANCE_WORKFLOW_PATH,
    parseArgs,
    REQUIRED_RUNTIME_IMPORTS,
    renderReport,
} from "./check-consumer-config.ts";
import type {ConsumerConfigFs} from "./check-consumer-config.ts";
import {ROUTING_CONFIG_PATH} from "./routing-config.ts";
import {REVIEWERS_PATH} from "./router.ts";

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
const fakeFs = (inputs: Record<string, string>): ConsumerConfigFs => ({
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
env:
  REVIEW_MAX_AI_CREDITS: "2500"
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

    it("errors on an empty team allowlist when the repo has an ownership map", () => {
        const inputs = validInstall();
        inputs[REVIEWERS_PATH] = "plugins/** @Khan/kore\n";
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    allowed-team-reviewers:\n      - kore\n",
            "",
        );
        expect(codes(check(inputs), "error")).toEqual([
            "config-empty-team-allowlist",
        ]);
    });

    // The distinction the error above rests on. With no REVIEWERS file the router
    // derives no owners and no ranked fallback, so Step 8 requests nobody whatever
    // the allowlist says: "no teams" is then an accurate configuration rather than a
    // dropped request, and erroring would only get an inert team invented to satisfy
    // the checker.
    it("treats an empty allowlist as deliberate when there is no ownership map", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    allowed-team-reviewers:\n      - kore\n",
            "",
        );
        const report = check(inputs);
        expect(codes(report, "error")).toEqual([]);
        expect(codes(report, "warning")).toEqual(["reviewer-requests-inert"]);
    });

    // Present-but-empty is a different animal from absent, and the checker must
    // not report it as the deliberate no-requests configuration: that would read
    // as an all-clear over an allowlist the safe output is dropping.
    it("errors on an allowlist key that yields no teams, with no ownership map", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace("      - kore\n", "");
        const report = check(inputs);
        expect(codes(report, "error")).toEqual(["config-empty-team-allowlist"]);
        expect(codes(report, "warning")).not.toContain(
            "reviewer-requests-inert",
        );
    });

    // Flow style is valid YAML and the shipped review.md uses it for `toolsets`,
    // so reading it as an empty allowlist was a false error on a working install.
    it("reads a flow-style allowlist", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    allowed-team-reviewers:\n      - kore\n",
            "    allowed-team-reviewers: [kore, web]\n",
        );
        const report = check(inputs);
        expect(codes(report, "error")).toEqual([]);
        expect(report.reviewerRouting.allowedTeamReviewers).toEqual([
            "kore",
            "web",
        ]);
    });

    it("stays quiet about the bot token when no request can be made", () => {
        const inputs = validInstall();
        inputs[CONFIG_IMPORT_PATH] = CONFIG_MD.replace(
            "    allowed-team-reviewers:\n      - kore\n",
            "",
        ).replace(
            "    github-token: ${{ secrets.KHAN_ACTIONS_BOT_TOKEN }}\n",
            "",
        );
        expect(codes(check(inputs), "warning")).toEqual([
            "reviewer-requests-inert",
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

// Every local edit the skill prescribes carries a `<REPO> LOCAL OVERRIDE:`
// comment, so an inline one on the very lines the checker reads is the expected
// shape rather than an exotic case.
describe("labelled local edits", () => {
    it("still reads max-ai-credits, source and imports through inline comments", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "max-ai-credits: 2500",
            "max-ai-credits: 2500 # KHAN/REPO LOCAL OVERRIDE: raised",
        )
            .replace(
                "source: Khan/actions/workflows/review/review.md@review-v1.11.0",
                "source: Khan/actions/workflows/review/review.md@review-v1.11.0 # pinned",
            )
            .replace(
                `  - ${CONFIG_IMPORT_PATH}`,
                `  - ${CONFIG_IMPORT_PATH} # consumer config`,
            );
        const report = check(inputs, {checkerVersion: "1.11.0"});
        expect(codes(report, "error")).toEqual([]);
        expect(codes(report, "warning")).toEqual([]);
        expect(report.installedWorkflow.maxAiCredits).toBe(2500);
        expect(report.installedWorkflow.pinnedRef).toBe("review-v1.11.0");
    });

    it("does not let a quoted credit ceiling suppress the default warning", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            "max-ai-credits: 2500",
            'max-ai-credits: "1000"',
        ).replace(
            'REVIEW_MAX_AI_CREDITS: "2500"',
            'REVIEW_MAX_AI_CREDITS: "1000"',
        );
        expect(codes(check(inputs), "warning")).toEqual([
            "max-ai-credits-default",
        ]);
    });

    it("accepts a quoted config import", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            `  - ${CONFIG_IMPORT_PATH}`,
            `  - "${CONFIG_IMPORT_PATH}"`,
        );
        expect(codes(check(inputs), "error")).toEqual([]);
    });
});

describe("the compiled lock", () => {
    it("errors when the lock is missing (nothing runs)", () => {
        const inputs = validInstall();
        delete inputs[INSTALLED_LOCK_PATH];
        expect(codes(check(inputs), "error")).toEqual(["lock-missing"]);
    });

    // Cause-then-effect: a missing lock is the error above, not additionally
    // a nag to mark the nonexistent file as generated (which would also flip
    // the --strict exit code).
    it("does not ask a lock-less repo to mark the lock generated", () => {
        const inputs = validInstall();
        delete inputs[INSTALLED_LOCK_PATH];
        delete inputs[".gitattributes"];
        expect(codes(check(inputs), "warning")).not.toContain(
            "lock-not-marked-generated",
        );
    });

    it("derives the lock path from a renamed --workflow and checks it", () => {
        const renamed = ".github/workflows/pr-review.md";
        const inputs = validInstall();
        inputs[renamed] = inputs[INSTALLED_WORKFLOW_PATH];
        delete inputs[INSTALLED_WORKFLOW_PATH];
        delete inputs[INSTALLED_LOCK_PATH];
        // Lock absent under the derived name: the error names it.
        const missing = check(inputs, {workflowPath: renamed});
        expect(codes(missing, "error")).toEqual(["lock-missing"]);
        expect(
            missing.issues.find((issue) => issue.code === "lock-missing")
                ?.message,
        ).toContain(".github/workflows/pr-review.lock.yml");
        // Lock present under the derived name (and marked generated): quiet.
        inputs[".github/workflows/pr-review.lock.yml"] = "# compiled\n";
        expect(codes(check(inputs, {workflowPath: renamed}), "error")).toEqual(
            [],
        );
    });

    it("warns when the lock is not marked linguist-generated", () => {
        const inputs = validInstall();
        delete inputs[".gitattributes"];
        expect(codes(check(inputs), "warning")).toEqual([
            "lock-not-marked-generated",
        ]);
    });

    // The gap the documented `*.lock.yml` marker leaves: gh-aw's maintenance
    // workflow is compiler output too, but its name does not end in `.lock.yml`, so
    // a repo that followed the instructions still gets ~600 generated lines
    // line-reviewed.
    it("warns when the gh-aw maintenance workflow is not marked generated", () => {
        const inputs = validInstall();
        inputs[MAINTENANCE_WORKFLOW_PATH] = "# generated by gh aw\n";
        expect(codes(check(inputs), "warning")).toEqual([
            "maintenance-workflow-not-marked-generated",
        ]);
    });

    it("is quiet once the maintenance workflow is marked generated", () => {
        const inputs = validInstall();
        inputs[MAINTENANCE_WORKFLOW_PATH] = "# generated by gh aw\n";
        const marker = `${MAINTENANCE_WORKFLOW_PATH} linguist-generated=true\n`;
        inputs[".gitattributes"] += marker;
        expect(codes(check(inputs), "warning")).toEqual([]);
    });

    it("says nothing about a maintenance workflow the repo does not have", () => {
        expect(codes(check(validInstall()), "warning")).toEqual([]);
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

describe("the source field", () => {
    it("warns when review.md carries no source: field at all", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            /^source: .*$\n/m,
            "",
        );
        expect(codes(check(inputs), "warning")).toEqual(["source-missing"]);
    });
});

describe("the credit-cap mirror", () => {
    it("warns when the env mirror is missing while the cap is raised", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            /^env:\n {2}REVIEW_MAX_AI_CREDITS: "2500"\n/m,
            "",
        );
        const report = check(inputs);
        expect(codes(report, "warning")).toEqual([
            "max-ai-credits-mirror-stale",
        ]);
        expect(
            report.issues.find(
                (issue) => issue.code === "max-ai-credits-mirror-stale",
            )?.message,
        ).toContain("no REVIEW_MAX_AI_CREDITS env mirror");
    });

    it("warns when the mirror disagrees with the frontmatter cap", () => {
        const inputs = validInstall();
        inputs[INSTALLED_WORKFLOW_PATH] = WORKFLOW_MD.replace(
            'REVIEW_MAX_AI_CREDITS: "2500"',
            'REVIEW_MAX_AI_CREDITS: "1000"',
        );
        const report = check(inputs);
        expect(codes(report, "warning")).toEqual([
            "max-ai-credits-mirror-stale",
        ]);
        expect(
            report.issues.find(
                (issue) => issue.code === "max-ai-credits-mirror-stale",
            )?.message,
        ).toContain("says 1000");
    });
});

describe("the shipped credit ceiling", () => {
    it("compares against the live shipped value when the CLI provides one", () => {
        // The shipped ceiling rose to meet the consumer's: the default warning
        // fires again, instead of comparing against the stale constant.
        const report = check(validInstall(), {shippedMaxAiCredits: 2500});
        expect(codes(report, "warning")).toContain("max-ai-credits-default");
    });
});

describe("lens payloads", () => {
    it("forwards the real lens-payload warnings", () => {
        const inputs = validInstall();
        // A specialist-lens payload no ROUTING rule routes: inert.
        inputs[".github/aw/review/lenses/security-auth.md"] =
            "### security-auth - extra rules\n";
        const report = check(inputs);
        expect(codes(report, "warning")).toContain("lens-payload-warning");
        expect(
            report.issues.find((issue) => issue.code === "lens-payload-warning")
                ?.message,
        ).toContain("inert");
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
        ).replace(
            'REVIEW_MAX_AI_CREDITS: "2500"',
            'REVIEW_MAX_AI_CREDITS: "1000"',
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

describe("the repo root", () => {
    it("throws on a --repo that is not a path on disk", () => {
        // `--repo Khan/webapp` parses fine and resolves as a relative path;
        // without the guard every check reports missing instead of naming
        // the typo.
        expect(() => check({}, {repoRoot: "Khan/webapp"})).toThrow(
            "--repo path does not exist: Khan/webapp",
        );
    });

    it("accepts a root that exists and prefixes every path with it", () => {
        const inputs = Object.fromEntries(
            Object.entries(validInstall()).map(([path, content]) => [
                `../consumer/${path}`,
                content,
            ]),
        );
        const report = checkConsumerConfig(fakeFs(inputs), {
            repoRoot: "../consumer",
            checkerVersion: "1.11.0",
        });
        expect(codes(report, "error")).toEqual([]);
        // Warnings too: warning-only checks (the .gitattributes lookup)
        // also resolve through the prefixed root, and an error-only
        // assertion cannot observe them.
        expect(codes(report, "warning")).toEqual([]);
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
