import {describe, expect, it, vi} from "vitest";
import {submissionPlanViolations} from "./dispatch-gate-plan";
import type {SubmissionPlanViolationsInput} from "./dispatch-gate-plan";
import {loadRunnerSanitizer} from "./sanitizer-runtime";

const cases = [
    "see `https://collector.attacker.example/x` and `<repo>` here",
    "see `https://collector.attacker.example/c?d=<repo text>` here",
];
const inputFor = (
    kind: string,
    plan: string,
    queued: string,
): SubmissionPlanViolationsInput => {
    if (kind === "hold") {
        return {
            items: [{type: "add_comment", body: queued}],
            submissionPlan: {event: "HOLD_FOR_HUMAN", body: plan},
            submit: undefined,
            verdictEvent: null,
            body: "",
            commentCount: 0,
        };
    }
    const inline = kind === "inline";
    const submit = {
        type: "submit_pull_request_review",
        event: "COMMENT",
        body: inline ? "Commented." : queued,
    };
    return {
        items: inline
            ? [
                  submit,
                  {
                      type: "create_pull_request_review_comment",
                      path: "src/file.ts",
                      line: 7,
                      body: queued,
                  },
              ]
            : [submit],
        submissionPlan: {
            event: "COMMENT",
            body: inline ? "Commented." : plan,
            comments: inline
                ? [{path: "src/file.ts", line: 7, body: plan}]
                : [],
        },
        submit,
        verdictEvent: "COMMENT",
        body: submit.body,
        commentCount: inline ? 1 : 0,
    };
};

// Reduced from agent-settings run 34887969288. The agent's payloads matched
// the plan, but ingest decoded the colon inside a regex and NFKC-folded an
// ellipsis. Explicit queued strings pin the observed output independently of
// the runtime used by the gate. The four-backtick fence matches the incident.
const decodingCases = [
    {
        name: "percent-encoded colon in a code fence",
        planned: [
            "````",
            String.raw`pattern: /^\/repos\/Khan\/webapp\/pulls\?head=Khan%3Aagent%2Ffeature&state=open$/,`,
            "````",
        ].join("\n"),
        queued: [
            "````",
            String.raw`pattern: /^\/repos\/Khan\/webapp\/pulls\?head=Khan:agent%2Ffeature&state=open$/,`,
            "````",
        ].join("\n"),
    },
    {
        name: "compatibility ellipsis in prose",
        planned:
            "fields the search-issues response carries (`body`, `title`, `labels`\u2026)",
        queued: "fields the search-issues response carries (`body`, `title`, `labels`...)",
    },
];

describe("rule 7 with the actual pinned sanitizer", () => {
    it.each([undefined, null])(
        "does not load the sanitizer without a staged plan (%s)",
        (submissionPlan) => {
            vi.stubEnv("RUNNER_TEMP", undefined);
            expect(
                submissionPlanViolations({
                    ...inputFor("review", "Commented.", "Commented."),
                    submissionPlan,
                }),
            ).toEqual([]);
        },
    );

    it.each(["review", "inline", "hold"])(
        "compares %s text in the correct roles",
        (kind) => {
            const runtime = loadRunnerSanitizer();
            for (const plan of cases) {
                const queued = runtime.sanitizeContentCore(plan);
                expect(
                    submissionPlanViolations(inputFor(kind, plan, queued)),
                ).toEqual([]);
                for (const changed of [
                    queued + " added prose",
                    queued.replace(
                        "collector.attacker.example",
                        "other.example",
                    ),
                ]) {
                    expect(
                        submissionPlanViolations(inputFor(kind, plan, changed)),
                    ).not.toEqual([]);
                }
            }
        },
    );

    it.each(["review", "inline", "hold"])(
        "does not accept the legacy code-tag/parenthesis splice in %s text",
        (kind) => {
            const plan = cases[0];
            const queued = loadRunnerSanitizer().sanitizeContentCore(plan);
            expect(queued).toContain("<repo>");
            expect(
                submissionPlanViolations(
                    inputFor(kind, plan, queued.replace("<repo>", "(repo)")),
                ),
            ).not.toEqual([]);
        },
    );

    describe.each(decodingCases)(
        "ingest decoding: $name",
        ({planned, queued}) => {
            it("matches the captured ingest transformation exactly", () => {
                expect(loadRunnerSanitizer().sanitizeContentCore(planned)).toBe(
                    queued,
                );
            });

            it.each(["review", "inline", "hold"])(
                "accepts faithful %s text but rejects added prose",
                (kind) => {
                    expect(
                        submissionPlanViolations(
                            inputFor(kind, planned, queued),
                        ),
                    ).toEqual([]);
                    expect(
                        submissionPlanViolations(
                            inputFor(kind, planned, queued + " Added prose."),
                        ),
                    ).toEqual([
                        expect.objectContaining({
                            code: "submission-plan-mismatch",
                        }),
                    ]);
                },
            );
        },
    );

    it.each(["review", "inline", "hold"])(
        "does not treat percent decoding as a wildcard in %s code",
        (kind) => {
            const {planned, queued} = decodingCases[0];
            for (const changed of [
                queued.replace("%2F", "/"),
                queued.replace("webapp", "actions"),
                queued.replace("feature", "different-branch"),
            ]) {
                expect(
                    submissionPlanViolations(inputFor(kind, planned, changed)),
                ).toEqual([
                    expect.objectContaining({code: "submission-plan-mismatch"}),
                ]);
            }
        },
    );

    it("still rejects changed inline anchors and missing or duplicate comments", () => {
        const plan = cases[0];
        const queued = loadRunnerSanitizer().sanitizeContentCore(plan);
        const original = inputFor("inline", plan, queued);
        const anchor = structuredClone(original);
        anchor.items[1].line = 8;
        expect(submissionPlanViolations(anchor)).not.toEqual([]);
        const missing = structuredClone(original);
        missing.items.pop();
        expect(submissionPlanViolations(missing)).not.toEqual([]);
        const duplicate = structuredClone(original);
        duplicate.items.push({...duplicate.items[1]});
        expect(submissionPlanViolations(duplicate)).not.toEqual([]);
    });
});
