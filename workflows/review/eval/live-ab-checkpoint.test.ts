import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {extractSamples} from "./aggregate";
import {
    header,
    liveCase,
    producerOver,
    scriptedRunner,
} from "./live-ab-fixtures";
import {
    assembleReport,
    createCheckpointer,
    runArm,
    type AbReport,
    type ArmProduce,
    type ArmRunReport,
    type MultiAbReport,
    type RunHeader,
} from "./live-ab";

describe("live A/B checkpoints", () => {
    let dir: string;
    let outPath: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "live-ab-ckpt-"));
        outPath = join(dir, "out", "live-ab-report.json");
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, {recursive: true, force: true});
    });

    const readJson = (): AbReport | MultiAbReport =>
        JSON.parse(readFileSync(outPath, "utf8")) as AbReport | MultiAbReport;
    const readMd = (): string =>
        readFileSync(outPath.replace(/\.json$/, ".md"), "utf8");

    it("writes a partial report after every case and a full one at the end", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1"), liveCase("case-2")];
        const ckpt = createCheckpointer({outPath, repeats: 1, header});
        expect(existsSync(outPath)).toBe(false);

        const seen: {baseline: number; candidate: number; partial?: true}[] =
            [];
        const caveats: string[] = [];
        const recallRows: string[] = [];
        const observe = (): void => {
            const report = readJson() as AbReport;
            seen.push({
                baseline: report.arms.baseline.runs.length,
                candidate: report.arms.candidate.runs.length,
                ...(report.partial === true ? {partial: true} : {}),
            });
            caveats.push(
                readMd().match(/So far baseline scored [^.]*\./)?.[0] ?? "",
            );
            recallRows.push(
                readMd()
                    .split("\n")
                    .find((line) => line.startsWith("| Must-catch recall")) ??
                    "",
            );
        };

        const baseline = await runArm(
            "baseline",
            cases,
            producerOver("baseline", runner),
            {
                maxUsd: 10,
                onCase: (soFar) => {
                    ckpt.baselineCase(soFar);
                    observe();
                },
            },
        );
        // After case 1 of 2 on the baseline arm: a partial report with the
        // candidate arm still empty, and the markdown caveat says exactly how
        // far each arm got at that checkpoint.
        expect(seen[0]).toEqual({baseline: 1, candidate: 0, partial: true});
        expect(caveats[0]).toBe(
            "So far baseline scored 1 of 2 cases, candidate 0 of 2.",
        );
        // The arm has finished by now: the latest checkpoint's header still
        // says partial (the candidate arm has not run).
        expect(readMd()).toContain("## Review live A/B (partial)");
        expect(readMd()).toContain(
            "PARTIAL REPORT: a checkpoint written mid-run",
        );
        expect(caveats[1]).toBe(
            "So far baseline scored 2 of 2 cases, candidate 0 of 2.",
        );

        const candidate = await runArm(
            "candidate",
            cases,
            producerOver("candidate", runner),
            {
                maxUsd: 10,
                onCase: (soFar) => {
                    ckpt.candidateCase(baseline)(soFar);
                    observe();
                },
            },
        );
        expect(seen).toEqual([
            {baseline: 1, candidate: 0, partial: true},
            {baseline: 2, candidate: 0, partial: true},
            {baseline: 2, candidate: 1, partial: true},
            {baseline: 2, candidate: 2, partial: true},
        ]);
        expect(caveats[2]).toBe(
            "So far baseline scored 2 of 2 cases, candidate 1 of 2.",
        );
        // While the candidate arm has not run, its column says so and the
        // delta is blank instead of reading as a 100-point regression. Once
        // it has scored a case the row is a real comparison again.
        expect(recallRows[0]).toBe(
            "| Must-catch recall | 100% | not run yet |  |",
        );
        expect(recallRows[2]).toBe("| Must-catch recall | 100% | 100% | +0% |");
        // No torn or leftover staging file beside the report.
        expect(existsSync(join(dir, "out", ".live-ab-report.json.tmp"))).toBe(
            false,
        );
        // A partial single-run report pools nothing.
        expect(extractSamples("ckpt", readJson())).toEqual([]);

        ckpt.repeatDone({
            ...header,
            arms: {baseline, candidate},
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });
        const {payload, markdown, candidateRunCount} = ckpt.finish();
        expect(candidateRunCount).toBe(2);
        expect((payload as AbReport).partial).toBeUndefined();
        expect((readJson() as AbReport).partial).toBeUndefined();
        expect(markdown).toContain("## Review live A/B\n");
        expect(readMd()).not.toContain("partial");
        expect(readMd()).not.toContain("PARTIAL");
        expect(extractSamples("final", readJson()).length).toBe(1);
    });

    it("marks a repeated run partial until the last repeat finishes", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1")];
        const oneCase: RunHeader = {
            ...header,
            provenance: {...header.provenance, caseCount: 1},
        };
        const ckpt = createCheckpointer({outPath, repeats: 2, header: oneCase});
        const armOf = (arm: "baseline" | "candidate"): Promise<ArmRunReport> =>
            runArm(arm, cases, producerOver(arm, runner), {maxUsd: 10});
        const pair = async (): Promise<AbReport> => ({
            ...header,
            arms: {
                baseline: await armOf("baseline"),
                candidate: await armOf("candidate"),
            },
            regressions: {lost: [], gained: []},
            adversarialFailures: [],
            gateRetries: [],
        });

        // The very first checkpoint, before any repeat has finished: the
        // in-progress repeat is the only entry, nothing pools, and the gate
        // has nothing to say yet.
        await runArm("baseline", cases, producerOver("baseline-r1", runner), {
            maxUsd: 10,
            onCase: ckpt.baselineCase,
        });
        const firstCheckpoint = readJson() as MultiAbReport;
        expect(firstCheckpoint.partial).toBe(true);
        expect(firstCheckpoint.repeats.map((r) => r.partial)).toEqual([true]);
        expect(firstCheckpoint.gate).toEqual([]);
        expect(extractSamples("ckpt", firstCheckpoint)).toEqual([]);
        expect(readMd()).toContain(
            "0 of 2 repeats finished, repeat 1 in progress (baseline scored 1 of 1 cases, candidate 0 of 1).",
        );
        expect(readMd()).toContain(
            "Adversarial hard gate: no flip so far (0 finished repeats), decided when the run finishes.",
        );

        const first = await pair();
        ckpt.repeatDone(first);
        const afterOne = readJson() as MultiAbReport;
        expect(afterOne.partial).toBe(true);
        expect(afterOne.repeats.length).toBe(1);
        expect(readMd()).toContain("## Review live A/B: 2 repeats (partial)");
        expect(readMd()).toContain("1 of 2 repeats finished.");
        // The finished repeat pools, nothing else does yet.
        expect(extractSamples("ckpt", afterOne).length).toBe(1);

        // Mid-repeat 2: the in-progress repeat rides along, itself partial.
        await runArm("baseline", cases, producerOver("baseline-r2", runner), {
            maxUsd: 10,
            onCase: ckpt.baselineCase,
        });
        const midTwo = readJson() as MultiAbReport;
        expect(midTwo.partial).toBe(true);
        expect(midTwo.repeats.length).toBe(2);
        expect(midTwo.repeats[1]?.partial).toBe(true);
        expect(readMd()).toContain(
            "1 of 2 repeats finished, repeat 2 in progress (baseline scored 1 of 1 cases, candidate 0 of 1).",
        );
        expect(extractSamples("ckpt", midTwo).length).toBe(1);

        ckpt.repeatDone(await pair());
        const {payload} = ckpt.finish();
        expect((payload as MultiAbReport).partial).toBeUndefined();
        expect((readJson() as MultiAbReport).partial).toBeUndefined();
        expect(readMd()).toContain("## Review live A/B: 2 repeats\n");
        expect(extractSamples("final", readJson()).length).toBe(2);
    });
    it("keeps a one-repeat gate flip provisional until the run finishes", async () => {
        // majorityGateFailures marks 1 failed of 1 finished as a strict
        // majority, so without the partial wording a single flip on the
        // first repeat would render as FAILURE CONFIRMED in the sticky
        // comment for the rest of the run.
        const produceMiss: ArmProduce = async () => ({
            findings: [],
            validation: [],
            perAgent: [],
        });
        const cases = [liveCase("inj-1", "adversarial-injection")];
        const ckpt = createCheckpointer({outPath, repeats: 2, header});
        const pair = async (): Promise<AbReport> => {
            const baseline = await runArm("baseline", cases, produceMiss, {
                maxUsd: 10,
            });
            const candidate = await runArm("candidate", cases, produceMiss, {
                maxUsd: 10,
            });
            return assembleReport(header, baseline, candidate, []);
        };

        ckpt.repeatDone(await pair());
        expect(readMd()).toContain(
            "### Adversarial hard gate (provisional, 1 finished repeat)",
        );
        expect(readMd()).toContain(
            "- inj-1: failed 1/1 finished repeats so far, decided when the run finishes",
        );
        expect(readMd()).not.toContain("FAILURE CONFIRMED");

        ckpt.repeatDone(await pair());
        ckpt.finish();
        expect(readMd()).toContain(
            "### Adversarial hard gate (strict majority over repeats)",
        );
        expect(readMd()).toContain(
            "- inj-1: failed 2/2 repeats: FAILURE CONFIRMED",
        );
    });
});

describe("assembleReport", () => {
    beforeEach(() => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("drops a gate flip the best-of-three settled as a flake, keeps a confirmed one", async () => {
        const produceMiss: ArmProduce = async () => ({
            findings: [],
            validation: [],
            perAgent: [],
        });
        const cases = [liveCase("inj-1", "adversarial-injection")];
        const baseline = await runArm("baseline", cases, produceMiss, {
            maxUsd: 10,
        });
        const candidate = await runArm("candidate", cases, produceMiss, {
            maxUsd: 10,
        });
        const attempt = {pass: true, failures: [], usd: 1};

        // No retries yet (the shape every checkpoint has): the gate reads
        // the flip as a failure.
        expect(
            assembleReport(header, baseline, candidate, []).adversarialFailures,
        ).toEqual([
            "inj-1: verdict APPROVE, expected REQUEST_CHANGES",
            "inj-1: missed spec bug",
        ]);
        // Both retries passed: the flip was a flake and the report is clean.
        const flake = assembleReport(header, baseline, candidate, [
            {caseId: "inj-1", attempts: [attempt, attempt], settledPass: true},
        ]);
        expect(flake.adversarialFailures).toEqual([]);
        expect(flake.gateRetries.length).toBe(1);
        // A failed retry confirms it.
        expect(
            assembleReport(header, baseline, candidate, [
                {
                    caseId: "inj-1",
                    attempts: [{pass: false, failures: ["x"], usd: 1}],
                    settledPass: false,
                },
            ]).adversarialFailures.length,
        ).toBe(2);
    });
});
