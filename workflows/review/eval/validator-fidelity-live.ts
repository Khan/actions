/* eslint-disable no-console -- Offline preparation and live eval CLI. */

import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseArgs} from "node:util";

import {loadFidelityFixtures} from "./claim-fidelity";
import {probeReadScope, sdkRunner} from "./live-runner";
import {githubSource, prepareSnapshot} from "./validator-fidelity-stage";
import {runValidatorFidelity} from "./validator-fidelity";

const main = async (): Promise<void> => {
    const {values} = parseArgs({
        options: {
            "prepare-only": {type: "boolean", default: false},
            "review-md": {
                type: "string",
                default: "workflows/review/review.md",
            },
            "output-dir": {type: "string"},
            repeats: {type: "string", default: "3"},
            "max-usd": {type: "string", default: "8"},
        },
    });
    const repeats = Number(values.repeats);
    const maxUsd = Number(values["max-usd"]);
    if (
        !Number.isInteger(repeats) ||
        repeats < 1 ||
        repeats > 20 ||
        !Number.isFinite(maxUsd) ||
        maxUsd <= 0
    ) {
        throw new Error(
            "Expected repeats in 1..20 and a positive spend threshold",
        );
    }
    const outputDir =
        values["output-dir"] ??
        mkdtempSync(join(tmpdir(), "validator-fidelity-"));
    mkdirSync(outputDir, {recursive: true});
    // Refuse to overwrite prior evidence, including a partial run.
    const reportPath = join(outputDir, "report.json");
    writeFileSync(reportPath, JSON.stringify({status: "preparing"}), {
        flag: "wx",
    });
    const save = (report: unknown): void =>
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.error(`Report: ${reportPath}`);
    try {
        if (!values["prepare-only"] && !process.env["ANTHROPIC_API_KEY"]) {
            throw new Error(
                "ANTHROPIC_API_KEY is required for live validator replays. No model calls were made.",
            );
        }
        const fixtures = loadFidelityFixtures();
        if (fixtures.length !== 3) {
            throw new Error("Expected the three pinned historical fixtures");
        }
        const reviewMd = readFileSync(values["review-md"], "utf8");
        const sourceRoot = join(outputDir, "sources");
        const snapshots = fixtures.map((fixture) => {
            console.error(
                `Preparing pinned source for ${fixture.corpusCase.id}`,
            );
            return prepareSnapshot(fixture, sourceRoot, githubSource);
        });
        if (values["prepare-only"]) {
            save({status: "prepared", modelCalls: 0, snapshots});
            return;
        }
        const transcriptsDir = join(outputDir, "transcripts");
        const probe = await probeReadScope({
            transcriptsDir: join(transcriptsDir, "probe"),
        });
        save({status: "probe", probe, snapshots});
        // A leak or an unproven probe blocks this experiment. Do not change
        // runners or permissions to recover a model that did not prove scope.
        if (!probe.ok) {
            throw new Error(`Read scope not proven: ${probe.detail}`);
        }
        const stageRoot = join(outputDir, "cases");
        mkdirSync(stageRoot);
        const report = await runValidatorFidelity(
            fixtures,
            snapshots,
            reviewMd,
            {
                sourceRoot,
                stageRoot,
                repeats,
                maxUsd,
                runner: sdkRunner({transcriptsDir}),
                checkpoint: (partial) =>
                    save({status: "running", probe, ...partial}),
            },
        );
        const complete = report.samples.every((s) => s.status === "scored");
        save({status: complete ? "complete" : "partial", probe, ...report});
        console.error(
            `${report.samples.filter((s) => s.status === "scored").length}/${
                report.samples.length
            } scored, $${report.spentUsd.toFixed(
                4,
            )} reported list cost. Probe cost is separate.`,
        );
        if (!complete) {
            process.exitCode = 1;
        }
    } catch (error) {
        const prior = JSON.parse(readFileSync(reportPath, "utf8"));
        save({...prior, status: "blocked", error: String(error)});
        throw error;
    }
};

if (process.argv[1]?.endsWith("validator-fidelity-live.ts")) {
    main().catch((error) => {
        console.error(String(error));
        process.exitCode = 1;
    });
}
