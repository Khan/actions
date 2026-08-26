/**
 * Rule 7 of the dispatch-conformance gate (dispatch-gate.ts): when a
 * submission plan is staged (`submission-plan.json`, scripted mode, slice
 * 4), the queued safe outputs must match it. Split out of dispatch-gate.ts
 * when the HOLD_FOR_HUMAN shape took that file over the max-lines cap; the
 * rules are unchanged and dispatch-gate.ts is the only production caller.
 *
 * The shapes enforced:
 *
 *   - A review-event plan (APPROVE / REQUEST_CHANGES): the queued event,
 *     body, and inline comments must match the plan under a
 *     sanitizer-tolerant normalization (`normalizeBody`,
 *     sanitizer-normalize.ts, which documents every absorbed transform),
 *     with the fingerprint stamp folded out of both bodies first
 *     (`stripRereviewStamp`: its payload is opaque high-entropy text a
 *     transcription garble should not withhold a review over);
 *     anything beyond that is a splice (#244) and blocks. The rule also
 *     owns the NO-submission shapes: queued comments with no submit would
 *     land as an ungated COMMENT review, and a silently-dropped plan would
 *     withhold a REQUEST_CHANGES verdict (or a disclosure), so only an
 *     APPROVE plan with no comments and a bare approve body may
 *     legitimately queue nothing (the Step 6 redundant-approval skip).
 *   - A HOLD_FOR_HUMAN plan (submission.ts's hold path: a core review pass
 *     produced no output on a would-be approval) is the inverse shape: no
 *     review submission, no inline comments, no thread resolutions, and
 *     exactly the plan's body queued as one standalone PR comment. A
 *     queued review submission, inline comment, or thread resolution, or
 *     a withheld hold comment, blocks (other safe-output kinds are outside
 *     this rule; their own frontmatter caps and rules govern them) — the
 *     production failure the hold exists for
 *     (Khan/actions#328's re-run) was precisely an APPROVE submitted over
 *     dead core lenses, so the gate must make "hold plan but approval
 *     posted anyway" a red run.
 *
 * Determinism boundary: a pure function of the queued items and the staged
 * plan; no model call, no clock, no prose about the code under review.
 */

import type {DispatchGateViolation, SafeOutputItem} from "./dispatch-gate";
import {renderReviewBody} from "./render-comment";
import {
    countRereviewStampBlocks,
    parseRereviewStamp,
    stripRereviewStamp,
} from "./rereview-mode";
import {normalizeBody} from "./sanitizer-normalize";

const COMMENT_TYPE = "create_pull_request_review_comment";
const RESOLVE_TYPE = "resolve_pull_request_review_thread";
const ADD_COMMENT_TYPE = "add_comment";

export type SubmissionPlanViolationsInput = {
    /** The validated safe-output queue (`agent_output.json` `items`). */
    items: SafeOutputItem[];
    /** Parsed `submission-plan.json` (unknown: agent-writable staging). */
    submissionPlan: unknown;
    /** The queued review submission item, when one exists. */
    submit: SafeOutputItem | undefined;
    /** The queued verdict event; null when no review submission is queued. */
    verdictEvent: string | null;
    /** The queued review body ("" when no submission is queued). */
    body: string;
    /** Queued inline review comment count. */
    commentCount: number;
};

/** Evaluate rule 7; returns [] when no plan is staged or nothing deviates. */
export const submissionPlanViolations = (
    input: SubmissionPlanViolationsInput,
): DispatchGateViolation[] => {
    const violations: DispatchGateViolation[] = [];
    const {items, submit, verdictEvent, body, commentCount} = input;

    // Defensive over agent-writable staged input, like every sibling parse
    // in the gate. `readJsonIfPresent` passes `JSON.parse("null")` straight
    // through, so a `submission-plan.json` containing literal `null` reaches
    // here as `null` — which a bare `!== undefined` guard admits, and the
    // property reads below then throw. That throw escapes to the CLI entry
    // catch, which exits 0 with the queue untouched: not a rule-7 failure but
    // a fail-open of ALL SEVEN rules. The sibling `priorReviews` parse was
    // hardened against exactly this shape; this one has to match it.
    const planStaged =
        typeof input.submissionPlan === "object" &&
        input.submissionPlan !== null
            ? (input.submissionPlan as {
                  event?: unknown;
                  body?: unknown;
                  comments?: unknown;
                  skipSubmission?: unknown;
              })
            : undefined;
    const planIsHold =
        planStaged !== undefined && planStaged.event === "HOLD_FOR_HUMAN";
    if (planStaged !== undefined && planIsHold) {
        // The hold shape (submission.ts's HOLD_FOR_HUMAN): the plan's body
        // posts as ONE standalone PR comment and nothing else queues. Each
        // deviation is its own violation so the report names everything
        // wrong at once.
        const planBody =
            typeof planStaged.body === "string" ? planStaged.body : "";
        if (submit !== undefined) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail:
                    `a ${
                        verdictEvent || "(no event)"
                    } review submission is queued but the ` +
                    "staged plan is HOLD_FOR_HUMAN (a hold submits no review)",
            });
        }
        if (commentCount > 0) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "inline comments",
                detail: `${commentCount} inline comment(s) queued but the staged HOLD_FOR_HUMAN plan posts none`,
            });
        }
        const queuedResolves = items.filter(
            (item) => item.type === RESOLVE_TYPE,
        ).length;
        if (queuedResolves > 0) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "thread resolutions",
                detail: `${queuedResolves} thread resolution(s) queued but a HOLD_FOR_HUMAN plan withholds resolutions (a partial run leaves existing threads standing)`,
            });
        }
        const holdCommentQueued = items.some(
            (item) =>
                item.type === ADD_COMMENT_TYPE &&
                normalizeBody(
                    typeof item.body === "string" ? item.body : "",
                ) === normalizeBody(planBody),
        );
        if (!holdCommentQueued) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "hold comment",
                detail:
                    "the staged plan is HOLD_FOR_HUMAN but no queued PR comment matches its body " +
                    "(normalized comparison); the hold disclosure would be withheld",
            });
        }
    }
    if (planStaged !== undefined && !planIsHold && submit === undefined) {
        const planComments = Array.isArray(planStaged.comments)
            ? planStaged.comments
            : [];
        if (commentCount > 0) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail: `${commentCount} inline comment(s) queued with no review submission (they would land as an ungated COMMENT review); the staged plan requires a ${String(
                    planStaged.event,
                )} submission`,
            });
        } else {
            // review.md's redundant-approval skip is narrower than "APPROVE
            // with no comments": the body must ALSO carry no `Note:` lines
            // and no accountability section, i.e. it is exactly the bare
            // comment-less-approve line (the fingerprint stamp posts as a
            // collapsed `<details>` block that survives normalizeBody, so
            // it is folded out first). Without the body
            // check, an APPROVE that shed a lens (carrying a mandatory
            // "Note: <lens> not assessed this run" disclosure) could be
            // dropped on the floor and still pass the gate green, silently
            // withholding both the disclosure and the approval.
            const bareApprove = normalizeBody(
                renderReviewBody({event: "APPROVE", hasInlineComments: false}),
            );
            const planBody =
                typeof planStaged.body === "string" ? planStaged.body : "";
            // The plan CLI owns this predicate (`skipSubmission`) so the
            // prompt and this gate cannot describe the skip differently —
            // they diverged once, over the collapsed low-confidence section
            // riding the body. Fall back to deriving it only for a plan
            // staged before the field existed.
            const planSkips =
                typeof planStaged.skipSubmission === "boolean"
                    ? planStaged.skipSubmission
                    : planStaged.event === "APPROVE" &&
                      planComments.length === 0 &&
                      normalizeBody(stripRereviewStamp(planBody)) ===
                          bareApprove;
            if (!planSkips) {
                violations.push({
                    code: "submission-plan-mismatch",
                    dimension: "verdict",
                    detail: `nothing queued but the staged plan is ${String(
                        planStaged.event,
                    )} with ${
                        planComments.length
                    } comment(s); only an APPROVE plan with no comments and a bare "${renderReviewBody(
                        {event: "APPROVE", hasInlineComments: false},
                    )}" body may skip the submission`,
                });
            }
        }
    }
    if (planStaged !== undefined && !planIsHold && submit !== undefined) {
        if (
            typeof planStaged.event === "string" &&
            verdictEvent !== planStaged.event
        ) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "verdict",
                detail: `queued event ${
                    verdictEvent || "(none)"
                } does not match the staged submission plan's ${
                    planStaged.event
                }`,
            });
        }
        if (
            typeof planStaged.body === "string" &&
            // The stamp is folded out of both sides before the normalized
            // comparison: a garbled or dropped payload degrades the next
            // run to "no fingerprint" (full depth) instead of withholding
            // this review (stripRereviewStamp documents the trade).
            normalizeBody(stripRereviewStamp(body)) !==
                normalizeBody(stripRereviewStamp(planStaged.body))
        ) {
            violations.push({
                code: "submission-plan-mismatch",
                dimension: "review body",
                detail: "queued review body does not match the staged submission plan (normalized comparison)",
            });
        }
        if (typeof planStaged.body === "string") {
            // The fold above tolerates a stamp the orchestrator garbled or
            // dropped, but must not tolerate one it REPLACED: a forged
            // well-formed fingerprint would post and steer the next run's
            // depth. A queued stamp that parses must equal the plan's;
            // corruption parses to null and stays on the degrade path.
            const queuedStamp = parseRereviewStamp(body);
            if (
                queuedStamp !== null &&
                JSON.stringify(queuedStamp) !==
                    JSON.stringify(parseRereviewStamp(planStaged.body))
            ) {
                violations.push({
                    code: "submission-plan-mismatch",
                    dimension: "fingerprint stamp",
                    detail: "queued review body carries a fingerprint stamp that does not match the staged plan's (a corrupted stamp may degrade to none, never to a different one)",
                });
            }
            // And never MORE stamp-shaped blocks than the plan staged: the
            // fold tolerates a garbled interior, so an extra skeleton-shaped
            // block is the one place text could ride through the comparison
            // unchecked. Fewer is fine (a dropped stamp is the degrade path).
            if (
                countRereviewStampBlocks(body) >
                countRereviewStampBlocks(planStaged.body)
            ) {
                violations.push({
                    code: "submission-plan-mismatch",
                    dimension: "fingerprint stamp",
                    detail: "queued review body carries more fingerprint-shaped blocks than the staged plan (the fold would hide their contents from the body comparison)",
                });
            }
        }
        if (Array.isArray(planStaged.comments)) {
            const planned = planStaged.comments
                .filter(
                    (
                        comment,
                    ): comment is {path: string; line: number; body: string} =>
                        typeof (comment as {path?: unknown}).path ===
                            "string" &&
                        typeof (comment as {body?: unknown}).body === "string",
                )
                .map(
                    (comment) =>
                        `${comment.path}:${comment.line}:${normalizeBody(
                            comment.body,
                        )}`,
                )
                .sort();
            const queued = items
                .filter((item) => item.type === COMMENT_TYPE)
                .map(
                    (item) =>
                        `${
                            typeof item["path"] === "string" ? item["path"] : ""
                        }:${String(item["line"] ?? "")}:${normalizeBody(
                            typeof item.body === "string" ? item.body : "",
                        )}`,
                )
                .sort();
            if (JSON.stringify(planned) !== JSON.stringify(queued)) {
                violations.push({
                    code: "submission-plan-mismatch",
                    dimension: "inline comments",
                    detail: `queued inline comments (${queued.length}) do not match the staged submission plan (${planned.length})`,
                });
            }
        }
    }

    return violations;
};
