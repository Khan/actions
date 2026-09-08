/**
 * Every live eval workflow runs the read-scope probe before any step that
 * dispatches reviewers, and hands it the transcripts directory the upload
 * step collects. The probe is the per-run proof that the installed SDK
 * honors the read scope; a workflow that spends first and probes later (or
 * never) has no such proof for the arms it paid for.
 */

import * as fs from "fs";
import {describe, expect, it} from "vitest";

const WORKFLOWS: {file: string; spends: string}[] = [
    {file: "review-eval-ab.yml", spends: "eval/live-ab.ts"},
    {file: "review-eval-drift.yml", spends: "eval/live-ab.ts"},
    {file: "review-rereview-sweep.yml", spends: "eval/rereview-sweep.ts"},
];

const PROBE = "live-runner.ts --probe-read-scope";
const TRANSCRIPTS = '--transcripts-dir "$RUNNER_TEMP/review-transcripts"';

describe.each(WORKFLOWS)("$file", ({file, spends}) => {
    const yml = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

    it("runs the read-scope probe before the step that spends", () => {
        const probeAt = yml.indexOf(PROBE);
        const spendAt = yml.indexOf(spends);
        expect(probeAt).toBeGreaterThan(-1);
        expect(spendAt).toBeGreaterThan(-1);
        expect(probeAt).toBeLessThan(spendAt);
    });

    it("gives both the probe and the run the uploaded transcripts dir", () => {
        const probeStep = yml.slice(yml.indexOf(PROBE), yml.indexOf(spends));
        expect(probeStep).toContain(TRANSCRIPTS);
        const runStep = yml.slice(yml.indexOf(spends));
        expect(runStep).toContain("review-transcripts");
        expect(yml).toContain("path: ${{ runner.temp }}/review-transcripts");
    });
});
