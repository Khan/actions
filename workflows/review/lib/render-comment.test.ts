import {describe, it, expect} from "vitest";

import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
    endsInHandoff,
    ensureTerminalPunctuation,
    isBlockingLabel,
    labelForFinding,
    renderComment,
    renderReviewBody,
    shouldFoldContext,
    type ReviewBodyInput,
} from "./render-comment.ts";
import {
    FINDING_SCHEMA_VERSION,
    assertFinding,
    type Finding,
    type Lens,
} from "./finding-schema.ts";
import {renderClaimComment} from "./submission-render.ts";

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
            "maintainability",
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

    // Same shape as the documentation variant, for the same reason: the label
    // is the selection key a maintainability-scoped autofix would use, so it
    // is reachable from the advisory row and only from it.
    it("advisory + maintainability lens -> suggestion (non-blocking, maintainability)", () => {
        expect(
            labelForFinding(
                makeFinding({severity: "advisory", lens: "maintainability"}),
            ),
        ).toBe("suggestion (non-blocking, maintainability)");
    });

    it("blocking + maintainability lens -> plain issue (blocking), no variant", () => {
        expect(labelForFinding(makeFinding({lens: "maintainability"}))).toBe(
            "issue (blocking)",
        );
        expect(
            BLOCKING_LABELS.filter((label) =>
                label.includes("maintainability"),
            ),
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

    it("keeps the committable fence outside and BELOW the block", () => {
        // Below, not between the summary and the block: dedup-threads'
        // threadProse truncates a posted body at its first ``` fence, so
        // a fence above the block would hide the discussion from
        // open-thread dedup (PR #401 review).
        const body = renderComment(
            makeFinding({
                model_authored_prose: longProse,
                summary: "Request params reach exec() unescaped.",
                suggested_patch: "exec(shellEscape(args))",
                rule_quote: "Never pass raw input to exec.",
            }),
        );
        const closeAt = body.indexOf("</details>");
        expect(body.indexOf("```suggestion")).toBeGreaterThan(closeAt);
        const ruleAt = body.indexOf(
            "> **Rule:** Never pass raw input to exec.",
        );
        expect(ruleAt).toBeGreaterThan(body.indexOf("<details>"));
        expect(ruleAt).toBeLessThan(closeAt);
    });

    it("stays byte-identical to renderClaimComment on the folded shape", () => {
        // The layout-parity contract: buildClaims turns this finding into a
        // claim whose subject is the summary and whose discussion is the
        // prose, and the two renderers must agree on the posted body.
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

describe("ensureTerminalPunctuation", () => {
    it("appends a period to a headline-style line", () => {
        expect(ensureTerminalPunctuation("The hunts land inert here")).toBe(
            "The hunts land inert here.",
        );
    });

    it("leaves already-terminated lines alone", () => {
        for (const line of [
            "Done.",
            "Really?",
            "Stop!",
            "An opener that hands off:",
        ]) {
            expect(ensureTerminalPunctuation(line)).toBe(line);
        }
    });

    it("sees punctuation inside closing quotes/brackets/emphasis", () => {
        // Same core-strip as joinProse: the terminator may sit inside
        // closers, and then the line is already terminated.
        expect(ensureTerminalPunctuation('He said "done."')).toBe(
            'He said "done."',
        );
        expect(ensureTerminalPunctuation("(a full sentence.)")).toBe(
            "(a full sentence.)",
        );
    });

    it("puts the period after an unterminated trailing closer", () => {
        // joinProse places its sentence break after the whole subject,
        // closers included, and the visible line must match it byte for
        // byte so the fold's opening restatement stays comparable. The
        // closer-ending inputs kill the core+"."+closers mutant, which
        // would break a trailing code span (PR #408 review).
        expect(ensureTerminalPunctuation("so `spawn()` never runs")).toBe(
            "so `spawn()` never runs.",
        );
        expect(ensureTerminalPunctuation("the gate is never `flipped`")).toBe(
            "the gate is never `flipped`.",
        );
        expect(ensureTerminalPunctuation('he called it "inert"')).toBe(
            'he called it "inert".',
        );
    });

    it("trims trailing whitespace and leaves the empty line empty", () => {
        expect(ensureTerminalPunctuation("A line ")).toBe("A line.");
        expect(ensureTerminalPunctuation("")).toBe("");
    });
});

describe("renderComment visible-line punctuation", () => {
    // The agent-settings#105 shape: a headline-style summary with no
    // terminal punctuation posted verbatim over the fold and read as a
    // truncated comment; the fold's own prose had the period because
    // joinProse repairs it at the join. The visible line now gets the
    // same repair.
    const longProse =
        "The hunts land inert here: no routing rule matches workflow " +
        "files, so the lens never spawns on them. The routing half is " +
        "consumer-owned and was not added, and this run's own routing " +
        "artifact shows lensesToSpawn empty for the workflow file.";

    it("adds the missing period to the folded visible line only", () => {
        const body = renderComment(
            makeFinding({
                model_authored_prose: longProse,
                summary:
                    "The hunts land inert here: no routing rule matches " +
                    "workflow files, so the lens never spawns on them",
            }),
        );
        const [visible] = body.split("\n");
        expect(visible).toBe(
            "**issue (blocking):** The hunts land inert here: no routing " +
                "rule matches workflow files, so the lens never spawns on them.",
        );
        // The prose inside the fold is untouched.
        expect(body).toContain(`\n\n${longProse}\n\n</details>`);
    });

    it("never doubles an existing terminator", () => {
        const body = renderComment(
            makeFinding({
                model_authored_prose: longProse,
                summary: "Request params reach exec() unescaped.",
            }),
        );
        expect(body.split("\n")[0]).toBe(
            "**issue (blocking):** Request params reach exec() unescaped.",
        );
    });
});

describe("shouldFoldContext hand-off refusal", () => {
    const prose =
        "Two things go wrong here: the retention pass subtracts months, " +
        "not days, so nothing is ever removed, and the test that should " +
        "have caught it asserts on the wrong constant, so it passes " +
        "against the broken implementation as written.";

    it("posts flat when the summary ends on a colon or semicolon", () => {
        // A colon hand-off over a collapsed block is the truncated look
        // the punctuation repair exists to remove, and a period would
        // misstate the sentence, so the clause and its completion post
        // together instead.
        expect(shouldFoldContext("Two things go wrong here:", prose)).toBe(
            false,
        );
        expect(shouldFoldContext("Two things go wrong here;", prose)).toBe(
            false,
        );
        expect(shouldFoldContext('Two things go wrong "here:"', prose)).toBe(
            false,
        );
        expect(endsInHandoff("A complete sentence.")).toBe(false);
        expect(
            renderComment(
                makeFinding({
                    model_authored_prose: prose,
                    summary: "Two things go wrong here:",
                }),
            ),
        ).toBe(`**issue (blocking):** ${prose}`);
    });
});

describe("shouldFoldContext block-close refusal", () => {
    it("posts flat when the prose carries a literal closing tag", () => {
        const prose =
            "A discussion long enough to clear the two-hundred-character bar " +
            "that quotes the `</details>` tag in backticks, which would still " +
            "end the surrounding block early on GitHub's HTML-block parse, " +
            "so this body must render in the flat shape instead.";
        expect(shouldFoldContext("The visible line.", prose)).toBe(false);
        const body = renderComment(
            makeFinding({
                model_authored_prose: prose,
                summary: "The visible line.",
            }),
        );
        expect(body).toBe(`**issue (blocking):** ${prose}`);
    });
});
