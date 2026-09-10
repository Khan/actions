import {describe, expect, it} from "vitest";

import {runArm} from "./live-ab";
import {header, liveCase, producerOver} from "./live-ab-fixtures";
import {assembleMulti, assembleReport} from "./live-ab-checkpoint";
import {renderMultiMarkdownReport} from "./live-ab-report";
import {compareUsefulCoverage, repeatedValueSummary} from "./live-value";

const pair = async (baselineHit = false, candidateHit = true) => {
    const arm = async (name: "baseline" | "candidate", hit: boolean) => {
        const produce = producerOver(name, async () => ({
            output: "{}",
            usd: name === "baseline" ? 0.25 : 0.5,
            turns: 1,
            wallMs: 1,
        }));
        return runArm(
            name,
            [liveCase("repeated")],
            async (c) => {
                const result = await produce(c);
                return {...result, findings: hit ? result.findings : []};
            },
            {maxUsd: 10, log: () => {}},
        );
    };
    return assembleReport(
        header,
        await arm("baseline", baselineHit),
        await arm("candidate", candidateHit),
        [],
    );
};

describe("repeated useful-catch value summaries", () => {
    it("renders pooled observations and per-repeat coverage with explicit denominators", async () => {
        const first = await pair();
        const second = await pair();
        second.arms.candidate.perCase[0]!.accounting!.coverage.shed = [
            "documentation",
        ];
        second.arms.candidate.skippedCases = ["budget-skipped"];
        second.value = compareUsefulCoverage(
            second.arms.baseline,
            second.arms.candidate,
        );
        const report = assembleMulti(2, [first, second]);
        const markdown = renderMultiMarkdownReport(report);
        expect(markdown).toContain(
            "Useful-catch value pooled over 2/2 finished repeats with value accounting (2 planned repeats): 2 paired case-runs, 1 unpaired case-runs.",
        );
        expect(markdown).toContain("2 gained, 0 lost, 2 net");
        expect(markdown).toContain(
            "Paired dispatch cost delta (list price): $1.00",
        );
        expect(markdown).toContain(
            "Dispatch cost per net useful catch (list price): $0.50",
        );
        expect(markdown).toContain(
            "Counts sum repeat observations, not distinct defects across repeats.",
        );
        expect(markdown).toContain("Repeat 1 (finished):");
        expect(markdown).toContain("Repeat 2 (finished):");
        expect(markdown).toContain(
            "candidate: 1/1 scored cases have incomplete or unrecorded modeled-reviewer coverage",
        );
        expect(markdown).toContain(
            "[repeated: shed documentation, absent none, failed none]",
        );
        expect(markdown).toContain(
            "Skipped cases (not scored): 1 (budget-skipped)",
        );
        expect(markdown).toContain("Coverage gaps are not clean passes");
    });

    it("doesn't pool unfinished repeats or treat missing value accounting as zero", async () => {
        const finished = await pair();
        const legacy = await pair();
        delete legacy.value;
        const partial = {...(await pair(true, false)), partial: true as const};
        const lines = repeatedValueSummary(
            assembleMulti(4, [finished, legacy, partial]),
        ).join("\n");
        expect(lines).toContain(
            "pooled over 1/2 finished repeats with value accounting (4 planned repeats): 1 paired case-runs, 0 unpaired case-runs",
        );
        expect(lines).toContain("1 gained, 0 lost, 1 net");
        expect(lines).toContain(
            "Repeat 2 (finished):\nUseful-catch value unavailable (no value accounting).",
        );
        expect(lines).toContain("Repeat 3 (in progress, excluded from pool):");
        expect(lines).toContain("0 gained, 1 lost, -1 net");
        expect(lines).toContain("n/a (net gain is not positive)");
    });

    it("uses the pooled net denominator rather than averaging repeat prices", async () => {
        const summary = repeatedValueSummary(
            assembleMulti(2, [await pair(), await pair(true, false)]),
        ).join("\n");
        expect(summary).toContain("1 gained, 1 lost, 0 net");
        expect(summary).toContain(
            "Inline coverage displaced in the pool: 0 defect observations.",
        );
        expect(summary).toContain(
            "Dispatch cost per net useful catch (list price): n/a (net gain is not positive).",
        );
    });

    it("reports no measured pool when no finished repeat has value accounting", async () => {
        const legacy = await pair();
        delete legacy.value;
        const summary = repeatedValueSummary(assembleMulti(2, [legacy])).join(
            "\n",
        );
        expect(summary).toContain(
            "pooled over 0/1 finished repeats with value accounting (2 planned repeats)",
        );
        expect(summary).toContain(
            "Useful-catch value unavailable (no finished repeat has value accounting).",
        );
        expect(summary).not.toContain("0 gained");
        expect(repeatedValueSummary(assembleMulti(2, [])).join("\n")).toContain(
            "pooled over 0/0 finished repeats",
        );
    });
});
