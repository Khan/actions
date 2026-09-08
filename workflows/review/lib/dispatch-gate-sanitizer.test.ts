import {describe, expect, it} from "vitest";
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

describe("rule 7 with the actual pinned sanitizer", () => {
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
