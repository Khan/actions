import {describe, it, expect} from "vitest";

import {loadCorpus} from "./corpus/loader";
import {stageCase, type StageFs} from "./live-stage";
import {
    buildSweepReport,
    renderSweepMarkdown,
    type SweepRow,
} from "./rereview-sweep";
import type {ReReviewMode} from "../lib/routing-config";

/* -------------------------------------------------------------------------- */
/* The pure report builders                                                   */
/* -------------------------------------------------------------------------- */

const rowOf = (over: Partial<SweepRow>): SweepRow => ({
    mode: "full",
    caseId: "case",
    executedDepth: "full",
    tripwireRearmed: false,
    usd: 1,
    caught: 1,
    specs: 1,
    missed: [],
    rereview: {
        resolutions: [
            {key: "t", expect: "resolve", got: "resolve", correct: true},
        ],
        resolutionAccuracy: 1,
        expectedKeptBlockingCount: 0,
        actualKeptBlockingCount: 0,
        flipGateCorrect: true,
        duplicateFindingIds: [],
    },
    failedAgents: [],
    ...over,
});

describe("buildSweepReport", () => {
    it("summarises each swept mode: recall, resolution, flips, dollars", () => {
        const report = buildSweepReport([
            rowOf({mode: "full", usd: 8}),
            rowOf({
                mode: "fast",
                usd: 0.8,
                caught: 0,
                missed: ["quota-cache-shared-key"],
                executedDepth: "fast",
            }),
        ]);
        expect(report.modes.map((m) => m.mode)).toEqual(["full", "fast"]);
        const [full, fast] = report.modes;
        expect(full.recall).toBe(1);
        expect(full.usd).toBe(8);
        // fast's zero fresh-defect recall is the mode's cost, priced here.
        expect(fast.recall).toBe(0);
        expect(fast.usd).toBe(0.8);
        expect(fast.resolutionAccuracy).toBe(1);
    });

    it("reports tripped cases so a full-executed row is not misread as the dial", () => {
        const report = buildSweepReport([
            rowOf({
                mode: "scoped",
                executedDepth: "full",
                tripwireRearmed: true,
            }),
        ]);
        expect(report.modes[0].trippedCases).toEqual(["case"]);
    });

    it("returns no recall when a mode's cases carry no specs", () => {
        const report = buildSweepReport([
            rowOf({mode: "fast", caught: 0, specs: 0}),
        ]);
        expect(report.modes[0].recall).toBeNull();
    });
});

describe("renderSweepMarkdown", () => {
    it("renders the pricing table with executed depths", () => {
        const markdown = renderSweepMarkdown(
            buildSweepReport([
                rowOf({mode: "scoped", executedDepth: "scoped", usd: 2.5}),
            ]),
        );
        expect(markdown).toContain("| scoped | 1 | 100% | 100% | 0 | 0 | 0 |");
        expect(markdown).toContain("scoped / case: executed scoped, $2.50");
    });
});

/* -------------------------------------------------------------------------- */
/* The under-tripwire case really exercises each reduced depth                */
/* -------------------------------------------------------------------------- */

const CORPUS = loadCorpus();
const FIX_PUSH = CORPUS.find((c) => c.id === "golden-retention-fix-push");
if (FIX_PUSH === undefined) {
    throw new Error("golden-retention-fix-push not in the corpus");
}

const memFs = (): StageFs & {files: Map<string, string>} => {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    return {
        files,
        existsSync: (p) =>
            files.has(p) ||
            dirs.has(p) ||
            [...files.keys()].some((k) => k.startsWith(`${p}/`)),
        mkdirSync: (p) => {
            dirs.add(p);
        },
        readdirSync: (p) => {
            const names = new Map<string, boolean>();
            for (const key of files.keys()) {
                if (!key.startsWith(`${p}/`)) {
                    continue;
                }
                const rest = key.slice(p.length + 1);
                const slash = rest.indexOf("/");
                if (slash === -1) {
                    names.set(rest, false);
                } else {
                    names.set(rest.slice(0, slash), true);
                }
            }
            return [...names.entries()].map(([name, isDir]) => ({
                name,
                isDirectory: () => isDir,
                isFile: () => !isDir,
            }));
        },
        readFileSync: (p) => {
            const content = files.get(p);
            if (content === undefined) {
                throw new Error(`ENOENT ${p}`);
            }
            return content;
        },
        writeFileSync: (p, data) => {
            files.set(p, data);
        },
    };
};

const seedTree = (fs: ReturnType<typeof memFs>): void => {
    const caseDir = FIX_PUSH.sourcePath.slice(
        0,
        FIX_PUSH.sourcePath.lastIndexOf("/"),
    );
    const nodeFs = require("node:fs") as typeof import("node:fs");
    const walk = (dir: string): void => {
        for (const entry of nodeFs.readdirSync(dir, {withFileTypes: true})) {
            const full = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(full);
            } else {
                fs.files.set(full, nodeFs.readFileSync(full, "utf8"));
            }
        }
    };
    walk(`${caseDir}/tree`);
};

describe("golden-retention-fix-push under each dial setting", () => {
    const depthOf = (mode: ReReviewMode) => {
        const fs = memFs();
        seedTree(fs);
        const staged = stageCase(FIX_PUSH, "/stage", fs, {
            reReviewMode: mode,
        });
        return {staged, fs};
    };

    it("stays under the tripwire, so every reduced depth actually executes", () => {
        for (const mode of ["scoped", "flip-gated", "fast"] as const) {
            const {staged} = depthOf(mode);
            expect(staged.rereviewPlan?.depth).toBe(mode);
            expect(staged.rereviewPlan?.tripwireRearmed).toBe(false);
        }
        expect(depthOf("full").staged.rereviewPlan?.depth).toBe("full");
    });

    it("scoped staging carries only the fix hunk, and it contains the fresh defect", () => {
        const {fs} = depthOf("scoped");
        const scoped = fs.files.get("/stage/context/full-stripped.diff") ?? "";
        // The fresh defect (the shared cache key) is inside the one new hunk.
        expect(scoped).toContain('cache.set("quota-remaining", remaining)');
        // The untouched regions of the PR are not re-staged.
        expect(scoped).not.toContain("x-quota-limit");
    });
});
