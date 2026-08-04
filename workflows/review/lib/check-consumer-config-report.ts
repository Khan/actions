/**
 * Text rendering for the consumer-config checker, split out of
 * `check-consumer-config.ts` by concern and its max-lines budget (the same split
 * `glob-match.ts` took from `router.ts`). The checker produces the report as
 * *data* and this module is the only place that decides how it reads, so a new
 * check needs no rendering change and a formatting change cannot alter a verdict.
 *
 * Determinism boundary: a pure function of the report. No filesystem, no model
 * call, no process exit — the caller owns those.
 */

import {RISK_TIERS} from "./router";
import type {ConfigIssue, ConsumerConfigReport} from "./check-consumer-config";

/** Human-readable report. Errors first, then warnings, then the summary. */
export const renderReport = (report: ConsumerConfigReport): string => {
    const lines: string[] = [];
    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );

    lines.push(`Reviewer config check: ${report.repoRoot}`);
    lines.push("");

    const section = (title: string, issues: ConfigIssue[]): void => {
        if (issues.length === 0) {
            return;
        }
        lines.push(`${title} (${issues.length})`);
        for (const issue of issues) {
            lines.push(`  [${issue.code}] ${issue.message}`);
            if (issue.fix !== undefined) {
                lines.push(`      fix: ${issue.fix}`);
            }
        }
        lines.push("");
    };
    section("ERRORS", errors);
    section("WARNINGS", warnings);

    const {routing, installedWorkflow: wf} = report;
    lines.push("Install");
    lines.push(
        `  source            ${wf.source ?? "(none)"}${
            wf.present ? "" : "  [workflow not installed]"
        }`,
    );
    lines.push(`  lock              ${wf.lockPresent ? "present" : "MISSING"}`);
    lines.push(`  max-ai-credits    ${wf.maxAiCredits ?? "(shipped default)"}`);
    lines.push(
        `  observability     ${wf.observabilityActive ? "active" : "disabled"}`,
    );
    lines.push(
        `  reviewer teams    ${
            report.reviewerRouting.allowedTeamReviewers.join(", ") || "(none)"
        }`,
    );
    lines.push("");
    lines.push("ROUTING");
    lines.push(`  present           ${routing.present ? "yes" : "NO"}`);
    lines.push(
        `  tier rules        ${routing.tierRules}    lens rules ${routing.lensRules}`,
    );
    lines.push(
        `  enabled reviewers ${
            routing.enabledReviewers.join(", ") || "(none)"
        }`,
    );
    lines.push(`  re-review         ${routing.reReviewMode}`);

    if (report.tierPreview !== undefined) {
        const preview = report.tierPreview;
        lines.push("");
        lines.push(
            `Tier preview over ${preview.fileCount} tracked files (${preview.generated} generated)`,
        );
        for (const tier of RISK_TIERS) {
            const count = preview.counts[tier];
            const sample = preview.samples[tier].join(", ");
            lines.push(
                `  ${tier.padEnd(8)} ${String(count).padStart(5)}${
                    sample === "" ? "" : `   e.g. ${sample}`
                }`,
            );
        }
        if (preview.deadPatterns.length > 0) {
            lines.push(
                `  dead patterns (match nothing): ${preview.deadPatterns.join(
                    ", ",
                )}`,
            );
        }
        lines.push(
            `  lenses on a whole-repo change: ${
                preview.lensesToSpawn.join(", ") || "(none)"
            }`,
        );
    }

    if (report.explanation !== undefined) {
        const explanation = report.explanation;
        lines.push("");
        lines.push(`Explanation: ${explanation.path}`);
        lines.push(
            `  tier    ${explanation.tier}${
                explanation.tierPending ? " (pending: direction-dependent)" : ""
            }${explanation.generated ? " (generated)" : ""}`,
        );
        lines.push(`  lenses  ${explanation.lenses.join(", ") || "(none)"}`);
        if (explanation.matchingTierRules.length === 0) {
            lines.push("  rules   (none matched; router default tier)");
        } else {
            lines.push("  rules   (last one wins)");
            for (const rule of explanation.matchingTierRules) {
                lines.push(
                    `            ${rule.pattern}  tier=${rule.tier}${
                        rule.diffDirectionDependent
                            ? " direction-dependent"
                            : ""
                    }`,
                );
            }
        }
    }

    lines.push("");
    lines.push(
        errors.length === 0
            ? `PASS with ${warnings.length} warning(s).`
            : `FAIL: ${errors.length} error(s), ${warnings.length} warning(s).`,
    );
    return `${lines.join("\n")}\n`;
};
