import {describe, it, expect} from "vitest";

import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
    isBlockingLabel,
    labelForFinding,
    renderComment,
    renderReviewBody,
    type ReviewBodyInput,
} from "./render-comment.ts";
import {
    FINDING_SCHEMA_VERSION,
    assertFinding,
    type Finding,
    type Lens,
} from "./finding-schema.ts";

/**
 * Rendering tests. The renderer sits on the determinism
 * boundary: CODE owns the label taxonomy + templated wrapping; MODELS own every
 * human-read sentence. These tests pin the deterministic label mapping and
 * snapshot the templated output so any drift in code-owned wrapping is caught,
 * while verifying model-authored prose/patches pass through verbatim.
 */

// Fixtures are run through the real schema validator so a rendering test can
// never pass against a finding the rest of the pipeline would reject.
const makeFinding = (overrides: Record<string, unknown> = {}): Finding =>
    assertFinding({
        schema_version: FINDING_SCHEMA_VERSION,
        id: "finding-1",
        lens: "security-auth",
        anchor: {type: "line", path: "src/app.ts", line: 42},
        severity: "blocking",
        confidence: 0.9,
        evidence_trace: ["src/app.ts:42 flows unsanitized input into exec()"],
        failure_scenario:
            "A request param containing shell metacharacters reaches exec() unescaped and runs arbitrary commands.",
        producing_hunt: "security-auth/command-injection",
        model_authored_prose:
            "User input flows unsanitized into a shell command.",
        ...overrides,
    });

describe("isBlockingLabel", () => {
    it.each([...BLOCKING_LABELS])("treats %s as blocking", (label) => {
        expect(isBlockingLabel(label)).toBe(true);
    });

    it.each([...NON_BLOCKING_LABELS])("treats %s as non-blocking", (label) => {
        expect(isBlockingLabel(label)).toBe(false);
    });

    it("treats an unknown label as non-blocking (safe default)", () => {
        expect(isBlockingLabel("praise (non-blocking)")).toBe(false);
        expect(isBlockingLabel("")).toBe(false);
    });
});

describe("labelForFinding — deterministic from severity + lens", () => {
    it("blocking + correctness lens -> issue (blocking)", () => {
        expect(labelForFinding(makeFinding({lens: "correctness"}))).toBe(
            "issue (blocking)",
        );
    });

    it("blocking + conventions (best-practice) lens -> issue (blocking, best-practice)", () => {
        expect(labelForFinding(makeFinding({lens: "conventions"}))).toBe(
            "issue (blocking, best-practice)",
        );
    });

    it("advisory + correctness lens -> suggestion (non-blocking)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "correctness"}),
            ),
        ).toBe("suggestion (non-blocking)");
    });

    it("medium renders exactly as advisory does (the no-new-labels invariant)", () => {
        // The tier's design rests on medium minting no label of its own:
        // every label-keyed consumer (verdict, recap parser, dedup guards,
        // flip gate) stays untouched only if this holds.
        for (const lens of [
            "security-auth",
            "conventions",
            "documentation",
        ] as const) {
            expect(
                labelForFinding(makeFinding({severity: "medium", lens})),
            ).toBe(labelForFinding(makeFinding({severity: "advisory", lens})));
        }
    });

    it("advisory + conventions lens -> suggestion (non-blocking, best-practice)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "conventions"}),
            ),
        ).toBe("suggestion (non-blocking, best-practice)");
    });

    it("advisory + documentation lens -> suggestion (non-blocking, documentation)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "documentation"}),
            ),
        ).toBe("suggestion (non-blocking, documentation)");
    });

    // The documentation variant is what a documentation-scoped autofix selects
    // on, so it must be reachable from the advisory row and ONLY from it: a
    // blocking documentation label would enlarge BLOCKING_LABELS, which is the
    // set the blocking autofix scope acts on.
    it("blocking + documentation lens -> plain issue (blocking), no docs variant", () => {
        expect(labelForFinding(makeFinding({lens: "documentation"}))).toBe(
            "issue (blocking)",
        );
    });

    it("mints no blocking documentation label", () => {
        expect(
            BLOCKING_LABELS.filter((label) => label.includes("documentation")),
        ).toEqual([]);
    });

    it("maps every specialist correctness lens to a plain (non-best-practice) label", () => {
        const specialist: Lens[] = [
            "security-auth",
            "money-payments",
            "concurrency-async",
            "data-migrations",
        ];
        for (const lens of specialist) {
            expect(labelForFinding(makeFinding({lens}))).toBe(
                "issue (blocking)",
            );
        }
    });
});

describe("renderComment — templated Conventional Comment", () => {
    it("renders a blocking finding with no suggested patch", () => {
        expect(renderComment(makeFinding())).toMatchInlineSnapshot(
            `"**issue (blocking):** User input flows unsanitized into a shell command."`,
        );
    });

    it("appends a verbatim ```suggestion block when a patch is present", () => {
        const finding = makeFinding({
            severity: "advisory",
            lens: "conventions",
            suggested_patch: "-  const x = 1\n+  const x = 2",
        });
        expect(renderComment(finding)).toMatchInlineSnapshot(`
          "**suggestion (non-blocking, best-practice):** User input flows unsanitized into a shell command.

          \`\`\`suggestion
          -  const x = 1
          +  const x = 2
          \`\`\`"
        `);
    });

    it("copies model-authored prose through verbatim (no synthesis/paraphrase)", () => {
        const prose =
            "This exact sentence — with an em-dash, `code`, and\na newline — must survive untouched.";
        const rendered = renderComment(
            makeFinding({model_authored_prose: prose}),
        );
        expect(rendered).toContain(prose);
    });

    it("copies a suggested patch through verbatim", () => {
        const patch = "-old line\n+new line";
        const rendered = renderComment(makeFinding({suggested_patch: patch}));
        expect(rendered).toContain(patch);
    });

    it("surfaces a skill finding's rule_quote as a Rule blockquote", () => {
        const rendered = renderComment(
            makeFinding({
                severity: "advisory",
                lens: "conventions",
                rule_quote:
                    "Always wrap errors with errors.Wrap before returning them.",
            }),
        );
        expect(rendered).toMatchInlineSnapshot(`
          "**suggestion (non-blocking, best-practice):** User input flows unsanitized into a shell command.

          > **Rule:** Always wrap errors with errors.Wrap before returning them."
        `);
    });

    it("keeps a multi-line rule_quote fully inside the blockquote", () => {
        const rendered = renderComment(
            makeFinding({
                severity: "advisory",
                lens: "conventions",
                rule_quote:
                    "Always wrap errors with errors.Wrap\nbefore returning them.",
            }),
        );
        expect(rendered).toMatchInlineSnapshot(`
          "**suggestion (non-blocking, best-practice):** User input flows unsanitized into a shell command.

          > **Rule:** Always wrap errors with errors.Wrap
          > before returning them."
        `);
    });

    it("keeps a rule_quote containing a blank line as one blockquote", () => {
        const rendered = renderComment(
            makeFinding({
                severity: "advisory",
                lens: "conventions",
                rule_quote: "First paragraph of the rule.\n\nSecond paragraph.",
            }),
        );
        // The blank line renders as a bare `>` so the blockquote never breaks:
        // every line after the prose (and its separating blank) is quoted.
        expect(rendered).toMatchInlineSnapshot(`
          "**suggestion (non-blocking, best-practice):** User input flows unsanitized into a shell command.

          > **Rule:** First paragraph of the rule.
          >
          > Second paragraph."
        `);
        const quoteLines = rendered.split("\n").slice(2);
        for (const line of quoteLines) {
            expect(line.startsWith(">")).toBe(true);
        }
    });

    it("orders prose, rule blockquote, then suggestion block", () => {
        const rendered = renderComment(
            makeFinding({
                rule_quote: "The exact rule text.",
                suggested_patch: "-a\n+b",
            }),
        );
        const proseAt = rendered.indexOf("User input flows");
        const ruleAt = rendered.indexOf("> **Rule:** The exact rule text.");
        const patchAt = rendered.indexOf("```suggestion");
        expect(proseAt).toBeGreaterThan(-1);
        expect(ruleAt).toBeGreaterThan(proseAt);
        expect(patchAt).toBeGreaterThan(ruleAt);
    });

    it("emits no Rule blockquote when rule_quote is absent", () => {
        expect(renderComment(makeFinding())).not.toContain("> **Rule:**");
    });
});

describe("renderReviewBody — one non-empty line per verdict (+ notes)", () => {
    const body = (overrides: Partial<ReviewBodyInput>): string =>
        renderReviewBody({
            event: "APPROVE",
            hasInlineComments: false,
            ...overrides,
        });

    it("APPROVE without inline comments", () => {
        expect(
            body({event: "APPROVE", hasInlineComments: false}),
        ).toMatchInlineSnapshot(`"Approved — no blocking issues found."`);
    });

    it("APPROVE with inline comments has an empty body (the comments ARE the review)", () => {
        expect(body({event: "APPROVE", hasInlineComments: true})).toBe("");
    });

    it("REQUEST_CHANGES always carries the pointer line (GitHub rejects an empty body)", () => {
        // The inline comments post separately from the review event, so they
        // never make it non-empty; an empty body loses the blocking verdict.
        expect(
            body({event: "REQUEST_CHANGES", hasInlineComments: true}),
        ).toMatchInlineSnapshot(`"Changes requested — see inline comments."`);
        expect(
            body({event: "REQUEST_CHANGES", hasInlineComments: false}),
        ).toMatchInlineSnapshot(`"Changes requested — see inline comments."`);
    });

    it("HOLD_FOR_HUMAN explains itself and how to get unstuck", () => {
        const rendered = body({
            event: "HOLD_FOR_HUMAN",
            hasInlineComments: false,
        });
        expect(rendered).toMatchInlineSnapshot(`
          "Holding for human review — the automated review could not complete safely this run.
          To get unstuck: push a new commit (or re-run the review workflow from the Actions tab) to retry the failed pass, or ask a human to review this PR manually. A hold means the automated review declined to approve on a partial assessment; it does not mean changes are required.
          A maintainer can apply the \`skip-ai-review\` label to opt this PR out of automated review."
        `);
    });

    it("HOLD_FOR_HUMAN is never empty, even with inline comments", () => {
        const rendered = body({
            event: "HOLD_FOR_HUMAN",
            hasInlineComments: true,
        });
        expect(rendered.split("\n")[0]).toBe(
            "Holding for human review — the automated review could not complete safely this run.",
        );
        expect(rendered).toContain("To get unstuck:");
    });

    it("HOLD_FOR_HUMAN renders policy-conflict lines before the unstuck instructions", () => {
        const rendered = body({
            event: "HOLD_FOR_HUMAN",
            hasInlineComments: false,
            policyConflicts: [
                {
                    policy: "skill-severity vs risk-tier",
                    detail: "the skill file marks this advisory; the risk config marks it blocking.",
                },
            ],
        });
        expect(rendered).toContain(
            "Policy conflict (skill-severity vs risk-tier): the skill file marks this advisory; the risk config marks it blocking.",
        );
        expect(rendered.indexOf("Policy conflict")).toBeLessThan(
            rendered.indexOf("To get unstuck:"),
        );
    });

    it("policy conflicts are ignored for non-hold verdicts", () => {
        expect(
            body({
                event: "APPROVE",
                hasInlineComments: true,
                policyConflicts: [{policy: "p", detail: "d"}],
            }),
        ).toBe("");
    });

    it("a comment-less review always has a non-empty body (GitHub requires one)", () => {
        const events: ReviewBodyInput["event"][] = [
            "APPROVE",
            "REQUEST_CHANGES",
            "HOLD_FOR_HUMAN",
        ];
        for (const event of events) {
            const first = renderReviewBody({
                event,
                hasInlineComments: false,
            }).split("\n")[0];
            expect(first.length).toBeGreaterThan(0);
        }
    });

    it("skipped-dimension notes form the entire body when the head is empty", () => {
        expect(
            body({
                event: "APPROVE",
                hasInlineComments: true,
                skippedDimensions: [
                    {dimension: "patterns", subAgent: "pattern-triage"},
                ],
            }),
        ).toBe(
            "Note: patterns not assessed this run (pattern-triage output unavailable).",
        );
    });

    it("appends one skipped-dimension note line per entry", () => {
        expect(
            body({
                event: "APPROVE",
                hasInlineComments: false,
                skippedDimensions: [
                    {
                        dimension: "correctness",
                        subAgent: "correctness-reviewer",
                    },
                    {
                        dimension: "claim validation",
                        subAgent: "claim-validator",
                    },
                ],
            }),
        ).toMatchInlineSnapshot(`
          "Approved — no blocking issues found.
          Note: correctness not assessed this run (correctness-reviewer output unavailable).
          Note: claim validation not assessed this run (claim-validator output unavailable)."
        `);
    });
});

describe("renderReviewBody — the COMMENT verdict", () => {
    it("always carries the middle verdict's head", () => {
        const body = renderReviewBody({
            event: "COMMENT",
            hasInlineComments: true,
        });
        expect(body).toContain(
            "Commented — medium-importance findings found; nothing blocks.",
        );
    });
});

describe("renderComment context fold", () => {
    const longProse =
        "User input flows unsanitized into a shell command. The request " +
        "param reaches exec() through buildArgs without passing " +
        "shellEscape, and the only caller that sanitizes is the CLI " +
        "entrypoint, so every HTTP path hits the raw join. Verified by " +
        "tracing buildArgs callers in src/app.ts and src/cli.ts.";

    it("folds long prose behind the authored summary", () => {
        const body = renderComment(
            makeFinding({
                model_authored_prose: longProse,
                summary: "Request params reach exec() unescaped.",
            }),
        );
        expect(body).toBe(
            [
                "**issue (blocking):** Request params reach exec() unescaped.",
                "",
                "<details><summary><sub>context</sub></summary>",
                "",
                longProse,
                "",
                "</details>",
            ].join("\n"),
        );
    });

    it("falls back to the first sentence when no summary is authored", () => {
        const body = renderComment(
            makeFinding({model_authored_prose: longProse}),
        );
        expect(
            body.startsWith(
                "**issue (blocking):** User input flows unsanitized into a shell command.",
            ),
        ).toBe(true);
        expect(body).toContain(
            "<details><summary><sub>context</sub></summary>",
        );
    });

    it("keeps short prose unfolded (the pre-fold shape, byte for byte)", () => {
        expect(renderComment(makeFinding())).toBe(
            "**issue (blocking):** User input flows unsanitized into a shell command.",
        );
    });

    it("keeps the committable fence outside, the rule quote inside", () => {
        const body = renderComment(
            makeFinding({
                model_authored_prose: longProse,
                summary: "Request params reach exec() unescaped.",
                suggested_patch: "exec(shellEscape(args))",
                rule_quote: "Never pass raw input to exec.",
            }),
        );
        const foldAt = body.indexOf("<details>");
        expect(body.indexOf("```suggestion")).toBeLessThan(foldAt);
        expect(
            body.indexOf("> **Rule:** Never pass raw input to exec."),
        ).toBeGreaterThan(foldAt);
    });

    it("stays byte-identical to renderClaimComment on the folded shape", async () => {
        // The layout-parity contract: buildClaims turns this finding into a
        // claim whose subject is the summary and whose discussion is the
        // prose, and the two renderers must agree on the posted body.
        const {renderClaimComment} = await import("./submission-render.ts");
        const finding = makeFinding({
            model_authored_prose: longProse,
            summary: "Request params reach exec() unescaped.",
        });
        const claimBody = renderClaimComment({
            id: "finding-1",
            source: "security-auth-reviewer",
            path: "src/app.ts",
            line: 42,
            label: "issue (blocking)",
            subject: "Request params reach exec() unescaped.",
            discussion: longProse,
            failure_scenario: "f",
            confidence: 0.9,
        });
        expect(renderComment(finding)).toBe(claimBody);
    });
});
