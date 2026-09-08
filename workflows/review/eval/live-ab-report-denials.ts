/**
 * The read-scope denial rows and sections of the live A/B report, shared by
 * the single-run and repeats renderers so the weekly drift run shows them
 * too. Split from live-ab-report.ts at the max-lines cap.
 */

import type {ArmRunReport, MultiAbReport} from "./live-ab-report";

/**
 * Scope denials, shared by both renderers so the weekly drift run (3
 * repeats) shows them too. Reads outside the staged case lead: a nonzero
 * count is a reviewer that went looking, and its transcript says where.
 * Tool-policy denials are listed apart, as the toolset-regression signal
 * they are, never as a corpus read. Repeats are summed per arm/case/agent.
 */
export const deniedSection = (
    pairs: readonly {baseline: ArmRunReport; candidate: ArmRunReport}[],
): string[] => {
    const sum = (
        pick: (
            c: ArmRunReport["perCase"][number],
        ) => {agent: string; count: number}[] | undefined,
    ): Map<string, number> => {
        const totals = new Map<string, number>();
        for (const {baseline, candidate} of pairs) {
            for (const [arm, report] of [
                ["baseline", baseline],
                ["candidate", candidate],
            ] as const) {
                for (const c of report.perCase) {
                    for (const d of pick(c) ?? []) {
                        const key = `${arm} / ${c.caseId} / ${d.agent}`;
                        totals.set(key, (totals.get(key) ?? 0) + d.count);
                    }
                }
            }
        }
        return totals;
    };
    const reads = sum((c) => c.deniedReads);
    const tools = sum((c) => c.deniedTools);
    const lines: string[] = [];
    if (reads.size > 0) {
        lines.push(
            "### Reviewers that read outside the staged case",
            "",
            ...[...reads].map(
                ([key, n]) =>
                    `- ${key}: ${n} read(s) denied; read its transcript`,
            ),
            "",
        );
    }
    if (tools.size > 0) {
        lines.push(
            "### Tool-policy denials (the `tools` restriction stopped restricting)",
            "",
            ...[...tools].map(
                ([key, n]) =>
                    `- ${key}: ${n} call(s) to a tool outside Read/Grep/Glob denied by the hook`,
            ),
            "",
        );
    }
    return lines;
};

/** Read-scope denials across the arm's agents; zero is the expected value. */
export const deniedTotal = (arm: ArmRunReport): number =>
    arm.perCase.reduce(
        (sum, c) =>
            sum + (c.deniedReads ?? []).reduce((n, d) => n + d.count, 0),
        0,
    );

/**
 * The pooled counterpart of the single-run table row, so a drift report
 * shows the zero as well as any nonzero, followed by the denial sections
 * summed over the repeats.
 */
export const pooledDeniedLines = (report: MultiAbReport): string[] => {
    const pooledDenied = (arm: "baseline" | "candidate"): number =>
        report.repeats.reduce(
            (sum, repeat) => sum + deniedTotal(repeat.arms[arm]),
            0,
        );
    return [
        `Reads denied outside the staged case: baseline ${pooledDenied(
            "baseline",
        )}, candidate ${pooledDenied("candidate")} (pooled over ${
            report.repeatCount
        } repeats).`,
        "",
        ...deniedSection(report.repeats.map((repeat) => repeat.arms)),
    ];
};
