/**
 * The re-review mode sweep: run the working tree's reviewer over the corpus's
 * open-PR (rereview) cases at EVERY dial setting and price the dial in one
 * table. Unlike `live-ab.ts` (two prompt versions, one mode), the sweep holds
 * the prompt fixed and varies only the `re-review` mode, which is exactly the
 * decision a repo faces when writing its ROUTING line.
 *
 * No special case format is needed: the mode is a run parameter, so the same
 * `live.rereview` cases replay at every mode. Three realities the report
 * handles instead:
 *
 *   - the divergence tripwire can OVERRIDE the dial (a heavily-diverged push
 *     re-arms `full` whatever the mode), so every row reports the EXECUTED
 *     depth next to the requested mode;
 *   - pricing the cheap paths therefore needs at least one under-threshold
 *     case (`golden-retention-fix-push`); a sweep over only tripped cases
 *     prices `full` four times and says so via the executed-depth column;
 *   - `fast` dispatches no finder, so fresh-defect recall under it is
 *     definitionally zero; that is the mode's cost, not a case failure, and
 *     the table shows it as recall against dollars.
 *
 * CLI (requires ANTHROPIC_API_KEY):
 *
 *   pnpm dlx tsx workflows/review/eval/rereview-sweep.ts
 *     [--modes <m,m,...>]    dial settings to sweep (default all four)
 *     [--cases <id,...>]    subset of rereview cases (default: all of them)
 *     [--max-usd <n>]       total hard budget across the sweep (default 30)
 *     [--stage-root <dir>]  staging root (default: a fresh temp dir)
 *     [--out <path>]        JSON report path (default out/rereview-sweep.json)
 */

/* eslint-disable no-console -- CLI entry point; console IS the interface. */

import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname} from "node:path";

import {extractAgents} from "./agent-extract";
import {loadLiveCorpus, type CorpusCase} from "./corpus/loader";
import {matchCase} from "./live-match";
import {produceLive} from "./live-producer";
import {sdkRunner} from "./live-runner";
import {scoreRereview, type RereviewCaseScore} from "./rereview-match";
import {runCase} from "./runner";
import {RE_REVIEW_MODES, type ReReviewMode} from "../lib/routing-config";

/** One (mode, case) run's scored row. */
export type SweepRow = {
    mode: ReReviewMode;
    caseId: string;
    /** The depth the plan actually executed (the tripwire may force full). */
    executedDepth: string;
    tripwireRearmed: boolean;
    usd: number;
    /** Fresh-defect recall on this push (mustCatchSpecs caught / total). */
    caught: number;
    specs: number;
    missed: string[];
    rereview: RereviewCaseScore;
    failedAgents: string[];
};

export type SweepModeSummary = {
    mode: ReReviewMode;
    cases: number;
    usd: number;
    /** Fresh-defect recall pooled across the mode's cases. */
    recall: number | null;
    resolutionAccuracy: number;
    flipGateWrongCases: string[];
    duplicateComments: number;
    /** Cases whose tripwire re-armed full (the dial did not apply). */
    trippedCases: string[];
};

export type SweepReport = {
    modes: SweepModeSummary[];
    rows: SweepRow[];
};

/** Aggregate rows into per-mode summaries. Pure; exported for tests. */
export const buildSweepReport = (rows: readonly SweepRow[]): SweepReport => {
    const modes: SweepModeSummary[] = [];
    for (const mode of RE_REVIEW_MODES) {
        const modeRows = rows.filter((row) => row.mode === mode);
        if (modeRows.length === 0) {
            continue;
        }
        const specs = modeRows.reduce((sum, row) => sum + row.specs, 0);
        const caught = modeRows.reduce((sum, row) => sum + row.caught, 0);
        const threads = modeRows.reduce(
            (sum, row) => sum + row.rereview.resolutions.length,
            0,
        );
        const correct = modeRows.reduce(
            (sum, row) =>
                sum + row.rereview.resolutions.filter((r) => r.correct).length,
            0,
        );
        modes.push({
            mode,
            cases: modeRows.length,
            usd: modeRows.reduce((sum, row) => sum + row.usd, 0),
            recall: specs === 0 ? null : caught / specs,
            resolutionAccuracy: threads === 0 ? 0 : correct / threads,
            flipGateWrongCases: modeRows
                .filter((row) => !row.rereview.flipGateCorrect)
                .map((row) => row.caseId),
            duplicateComments: modeRows.reduce(
                (sum, row) => sum + row.rereview.duplicateFindingIds.length,
                0,
            ),
            trippedCases: modeRows
                .filter((row) => row.tripwireRearmed)
                .map((row) => row.caseId),
        });
    }
    return {modes, rows: [...rows]};
};

/** Render the pricing table. Pure; exported for tests. */
export const renderSweepMarkdown = (report: SweepReport): string => {
    const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
    const lines = [
        "## Re-review mode sweep",
        "",
        "| Mode | Cases | Recall | Thread resolution | Flip wrong | Dups | Tripped | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...report.modes.map(
            (m) =>
                `| ${m.mode} | ${m.cases} | ${
                    m.recall === null ? "n/a" : pct(m.recall)
                } | ${pct(m.resolutionAccuracy)} | ${
                    m.flipGateWrongCases.length
                } | ${m.duplicateComments} | ${
                    m.trippedCases.length
                } | $${m.usd.toFixed(2)} |`,
        ),
        "",
        "Executed depths per case (the tripwire may force full):",
        ...report.rows.map(
            (row) =>
                `- ${row.mode} / ${row.caseId}: executed ${row.executedDepth}${
                    row.tripwireRearmed ? " (tripwire)" : ""
                }, $${row.usd.toFixed(2)}${
                    row.missed.length > 0
                        ? `, missed ${row.missed.join(", ")}`
                        : ""
                }`,
        ),
        "",
    ];
    return lines.join("\n");
};

const argValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
    if (!process.env["ANTHROPIC_API_KEY"]) {
        throw new Error("ANTHROPIC_API_KEY is required for a live sweep.");
    }
    const rawModes = (argValue("--modes") ?? RE_REVIEW_MODES.join(",")).split(
        ",",
    );
    for (const mode of rawModes) {
        if (!(RE_REVIEW_MODES as readonly string[]).includes(mode)) {
            throw new Error(`unknown mode "${mode}"`);
        }
    }
    const modes = rawModes as ReReviewMode[];
    const maxUsd = Number(argValue("--max-usd") ?? "30");
    const outPath = argValue("--out") ?? "out/rereview-sweep.json";
    const stageRoot =
        argValue("--stage-root") ?? mkdtempSync(`${tmpdir()}/review-sweep-`);
    const caseFilter = argValue("--cases")?.split(",");

    const allCases = loadLiveCorpus().filter(
        (c) => c.live?.rereview !== undefined,
    );
    const cases: CorpusCase[] =
        caseFilter === undefined
            ? allCases
            : allCases.filter((c) => caseFilter.includes(c.id));
    if (cases.length === 0) {
        throw new Error("no rereview-enabled live cases selected");
    }

    const agents = extractAgents(
        readFileSync("workflows/review/review.md", "utf8"),
    );
    const runner = sdkRunner();

    const rows: SweepRow[] = [];
    let usd = 0;
    for (const mode of modes) {
        for (const corpusCase of cases) {
            const rereviewSpec = corpusCase.live?.rereview;
            if (rereviewSpec === undefined) {
                continue;
            }
            const average = rows.length === 0 ? 0 : usd / rows.length;
            if (usd + average > maxUsd) {
                console.error(
                    `budget: stopping before ${mode}/${corpusCase.id} ` +
                        `($${usd.toFixed(2)} spent of $${maxUsd})`,
                );
                break;
            }
            const produced = await produceLive(corpusCase, agents, {
                runner,
                stageDir: `${stageRoot}/${mode}/${corpusCase.id}`,
                reReviewMode: mode,
            });
            const caseUsd = produced.perAgent.reduce(
                (sum, a) => sum + a.usd,
                0,
            );
            usd += caseUsd;

            const result = runCase(corpusCase, {
                produceFindings: () => produced.findings,
                validation: produced.validation,
            });
            const match = await matchCase(corpusCase, result);
            const rereview = scoreRereview(
                rereviewSpec,
                produced.reconciliation,
                produced.findings.map((recorded) => recorded.finding),
            );
            rows.push({
                mode,
                caseId: corpusCase.id,
                executedDepth: produced.staged.rereviewPlan?.depth ?? "full",
                tripwireRearmed:
                    produced.staged.rereviewPlan?.tripwireRearmed ?? false,
                usd: caseUsd,
                caught: match.caught.length,
                specs: corpusCase.live?.mustCatchSpecs?.length ?? 0,
                missed: match.missed,
                rereview,
                failedAgents: produced.perAgent
                    .filter((a) => a.failed !== undefined)
                    .map((a) => a.name),
            });
        }
    }

    const report = buildSweepReport(rows);
    mkdirSync(dirname(outPath), {recursive: true});
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(renderSweepMarkdown(report));
    console.log(`report: ${outPath} ($${usd.toFixed(2)} total)`);
};

// Run only when executed directly, never on import (tests import the pure
// report builders).
if (typeof require !== "undefined" && require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
