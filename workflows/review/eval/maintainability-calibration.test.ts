import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import ts from "typescript";
import {describe, expect, it} from "vitest";

import {computeRoster} from "../lib/dispatch-roster";
import {loadCorpus, type RecordedFinding} from "./corpus/loader";
import {matchCase, matchesSpec} from "./live-match";
import {runCase, toCandidate} from "./runner";

const cases = loadCorpus().filter(
    (c) =>
        c.tags.includes("maintainability") &&
        !c.tags.includes("maintainability-expanded"),
);
const fullRoster = [
    "holistic",
    "completeness",
    "test-adequacy",
    "first-principles",
    "conventions",
    "documentation",
    "maintainability",
];
const sample = cases.flatMap((c) => c.findings)[0]!;

// These controls calibrate fixture scoring. They don't measure model recall.
describe("original maintainability screening fixture calibration", () => {
    it("uses all six existing opt-ins, plus the candidate, in every case", () => {
        expect(cases).toHaveLength(6);
        for (const c of cases) {
            expect(c.routerConfig?.enabledReviewers).toEqual(fullRoster);
        }
    });
    for (const c of cases) {
        it(`replays the recorded expectations for ${c.id}`, async () => {
            const result = runCase(c, {posting: {depth: "full"}});
            const match = await matchCase(c, result);
            expect(match.missed).toEqual([]);
            expect(match.caught.map((hit) => hit.specKey)).toEqual(
                c.live?.mustCatchSpecs?.map((s) => s.key) ?? [],
            );
            expect(match.falseFlags).toEqual([]);
            expect(match.unmatchedFindingIds).toEqual([]);
            expect(result.plannedReview.comments).toHaveLength(
                c.expected.postedCommentCount ?? 0,
            );
        });
        it(`typechecks the complete tree for ${c.id}`, () => {
            const tree = resolve(dirname(c.sourcePath), c.live!.tree);
            const files = ts.sys.readDirectory(tree, [".ts"], undefined, [
                "**/*.ts",
            ]);
            expect(files.length).toBeGreaterThan(0);
            const program = ts.createProgram(files, {
                strict: true,
                noEmit: true,
                skipLibCheck: true,
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                moduleResolution: ts.ModuleResolutionKind.Node10,
                types: ["node"],
            });
            expect(
                ts
                    .getPreEmitDiagnostics(program)
                    .map((d) =>
                        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                    ),
            ).toEqual([]);
        });
        for (const spec of c.live?.mustCatchSpecs ?? []) {
            it(`doesn't match ${spec.key} from its anchor and evidence alone`, () => {
                const positive = c.findings[0]!;
                const negative = toCandidate({
                    ...positive,
                    finding: {
                        ...positive.finding,
                        failure_scenario:
                            "The behavior is unrelated to the seeded defect.",
                        model_authored_prose:
                            "This observation discusses an unrelated concern.",
                    },
                });
                expect(matchesSpec(negative, spec)).toBe(false);
            });
        }
        for (const trap of c.live?.mustNotFlagSpecs ?? []) {
            it(`recognizes ${trap.key} if a reviewer posts the false flag`, async () => {
                const phrase = trap.mechanism[0]!;
                const record: RecordedFinding = {
                    source: "maintainability",
                    finding: {
                        ...sample.finding,
                        id: trap.key,
                        anchor: {
                            type: "line",
                            path: trap.path!,
                            line: trap.lineStart!,
                            side: "RIGHT",
                        },
                        failure_scenario: phrase,
                        model_authored_prose: phrase,
                    },
                };
                const candidate = toCandidate(record);
                expect(matchesSpec(candidate, trap)).toBe(true);
                for (const positive of c.live?.mustCatchSpecs ?? []) {
                    expect(matchesSpec(candidate, positive)).toBe(false);
                }
                const result = runCase(c);
                // A matcher control, independent of whether provenance drops this trap.
                const match = await matchCase(c, {
                    ...result,
                    postedCandidates: [candidate],
                });
                expect(match.falseFlags.map((f) => f.specKey)).toEqual([
                    trap.key,
                ]);
            });
        }
    }
});

describe("maintainability budget displacement", () => {
    it("separates cap recovery from the same-cap reviewer delta in the nine field rounds", () => {
        const evidence = JSON.parse(
            readFileSync(`${__dirname}/field-parity-evidence.json`, "utf8"),
        ) as {rounds: {lenses: string[]}[]};
        const replay = (cap: number, enabled: string[]) =>
            evidence.rounds.map((round) =>
                computeRoster(
                    "full",
                    {
                        enabledReviewers: enabled,
                        lensesToSpawn: round.lenses,
                        runBudget: {maxReviewerInvocations: cap},
                    },
                    false,
                ),
            );
        const oldOff = replay(
            8,
            fullRoster.filter((r) => r !== "maintainability"),
        );
        const newOff = replay(
            9,
            fullRoster.filter((r) => r !== "maintainability"),
        );
        const newOn = replay(9, fullRoster);
        const sheds = (runs: ReturnType<typeof replay>, name: string) =>
            runs.filter((r) => r.shed.some((s) => s.name === name)).length;
        expect(sheds(oldOff, "documentation")).toBe(9);
        expect(sheds(newOff, "documentation")).toBe(1);
        expect(sheds(newOn, "documentation")).toBe(9);
        expect(
            newOn.filter((r) => r.finders.includes("maintainability")),
        ).toHaveLength(8);
    });
});
