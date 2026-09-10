import {execFileSync} from "node:child_process";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import ts from "typescript";
import {describe, expect, it} from "vitest";
import {Volume} from "memfs";

import {
    cases,
    filesUnder,
    hash,
    manifest,
    programFor,
} from "./maintainability-corpus-fixtures";
import {runCase, toCandidate} from "./runner";
import {matchCase, matchesSpec} from "./live-match";
import {selectCases} from "./live-ab";
import {stageCase} from "./live-stage";
import {volFs} from "./live-producer-fixtures";

const byId = new Map(cases.map((c) => [c.id, c]));

describe("expanded maintainability corpus integrity", () => {
    it("pins the prompt, source trees, partitions, and complete consumer roster", () => {
        expect(cases).toHaveLength(20);
        expect(manifest.entries).toHaveLength(cases.length);
        const markdown = readFileSync(`${__dirname}/../review.md`, "utf8");
        const prompt = markdown
            .split("## agent: `maintainability`\n")[1]!
            .split("\n## agent:")[0]!;
        expect(hash(prompt)).toBe(manifest.promptSectionSha256);
        for (const c of cases) {
            expect(c.id).toMatch(/^maint-snapshot-[a-f0-9]{8}$/);
            expect(c.tags).not.toContain("smoke");
            expect(c.routerConfig?.enabledReviewers).toEqual([
                "holistic",
                "completeness",
                "test-adequacy",
                "first-principles",
                "conventions",
                "documentation",
                "maintainability",
            ]);
        }
        const families = new Set(manifest.entries.map((e) => e.family));
        expect(families.size).toBe(9);
        for (const family of families) {
            expect(
                new Set(
                    manifest.entries
                        .filter((e) => e.family === family)
                        .map((e) => e.partition),
                ).size,
            ).toBe(1);
        }
        const heldOut = cases.filter((c) =>
            c.tags.includes("reserved-holdout"),
        );
        expect(heldOut).toHaveLength(4);
        expect(selectCases(cases, {smokeOnly: false})).toHaveLength(16);
        expect(() =>
            selectCases(cases, {
                smokeOnly: false,
                caseFilter: [heldOut[0]!.id],
            }),
        ).toThrow("--include-reserved-holdout");
        expect(
            selectCases(cases, {
                smokeOnly: false,
                includeReservedHoldout: true,
            }),
        ).toHaveLength(20);
        expect(
            selectCases(cases, {
                smokeOnly: false,
                includeReservedHoldout: true,
                caseFilter: heldOut.map((c) => c.id),
            }),
        ).toEqual(heldOut);
    });
    for (const entry of manifest.entries) {
        const c = byId.get(entry.id)!;
        it(`freezes the files and applies the diff for ${entry.name}`, () => {
            expect(
                hash(readFileSync(`${entry.casePath}/case.json`, "utf8")),
            ).toBe(entry.caseSha256);
            const tree = `${entry.casePath}/tree`;
            expect(filesUnder(tree)).toEqual(Object.keys(entry.tree).sort());
            for (const [path, digest] of Object.entries(entry.tree)) {
                expect(hash(readFileSync(`${tree}/${path}`, "utf8"))).toBe(
                    digest,
                );
            }
            expect(c.tags).toContain(
                `snapshot-${hash(
                    JSON.stringify(
                        Object.entries(entry.tree).sort(([a], [b]) =>
                            a < b ? -1 : a > b ? 1 : 0,
                        ),
                    ),
                )}`,
            );
            const dir = mkdtempSync(join(tmpdir(), "maint-diff-"));
            try {
                cpSync(tree, dir, {recursive: true});
                for (const file of c.changedFiles) {
                    const before = readFileSync(
                        `${entry.casePath}/before/${file.path}.txt`,
                        "utf8",
                    );
                    expect(hash(before)).toBe(entry.before[file.path]);
                    if (file.status === "added") {
                        rmSync(join(dir, file.path));
                    } else {
                        writeFileSync(join(dir, file.path), before);
                    }
                }
                const patch = join(dir, "case.patch");
                writeFileSync(patch, c.diff!);
                execFileSync(
                    "git",
                    ["apply", "--check", "--whitespace=nowarn", patch],
                    {cwd: dir},
                );
                execFileSync("git", ["apply", "--whitespace=nowarn", patch], {
                    cwd: dir,
                });
                for (const file of c.changedFiles) {
                    expect(readFileSync(join(dir, file.path), "utf8")).toBe(
                        readFileSync(`${tree}/${file.path}`, "utf8"),
                    );
                }
            } finally {
                rmSync(dir, {recursive: true, force: true});
            }
        });
        it(`scores the recorded reference and negative witnesses for ${entry.name}`, async () => {
            const result = runCase(c, {posting: {depth: "full"}});
            const matched = await matchCase(c, result);
            expect(matched.missed).toEqual([]);
            expect(matched.falseFlags).toEqual([]);
            expect(matched.unmatchedFindingIds).toEqual([]);
            expect(matched.caught.map((s) => s.specKey)).toEqual(
                c.live?.mustCatchSpecs?.map((s) => s.key) ?? [],
            );
            for (const spec of c.live?.mustCatchSpecs ?? []) {
                const reference = c.findings.find(
                    (f) => f.finding.id === spec.key,
                )!;
                const generic = toCandidate({
                    ...reference,
                    finding: {
                        ...reference.finding,
                        failure_scenario: "Inspect this code",
                        model_authored_prose: "Inspect this code",
                        evidence_trace: [reference.finding.failure_scenario],
                    },
                });
                const unrelated = toCandidate({
                    ...reference,
                    finding: {
                        ...reference.finding,
                        anchor: {
                            type: "line",
                            path: "src/unrelated.ts",
                            line: 1,
                            side: "RIGHT",
                        },
                    },
                });
                expect(matchesSpec(generic, spec)).toBe(false);
                expect(matchesSpec(unrelated, spec)).toBe(false);
            }
            for (const trap of c.live?.mustNotFlagSpecs ?? []) {
                const prose = manifest.negativeWitnesses[trap.key];
                expect(prose).toBeTruthy();
                const candidate = toCandidate({
                    source: "maintainability",
                    finding: {
                        schema_version: 2,
                        id: trap.key,
                        lens: trap.lens ?? "maintainability",
                        severity: "advisory",
                        confidence: 0.8,
                        anchor: {
                            type: "line",
                            path: trap.path!,
                            line: trap.lineStart!,
                            side: "RIGHT",
                        },
                        producing_hunt: "negative-control",
                        evidence_trace: [trap.path!],
                        failure_scenario: prose!,
                        model_authored_prose: prose!,
                    },
                });
                expect(matchesSpec(candidate, trap)).toBe(true);
                const falseFlag = await matchCase(c, {
                    ...result,
                    postedCandidates: [candidate],
                });
                expect(falseFlag.falseFlags.map((f) => f.specKey)).toEqual([
                    trap.key,
                ]);
                for (const positive of c.live?.mustCatchSpecs ?? []) {
                    expect(matchesSpec(candidate, positive)).toBe(false);
                }
            }
        });
        if (entry.kind === "authored") {
            it(`typechecks the authored tree for ${entry.name}`, () => {
                const program = programFor(resolve(entry.casePath, "tree"));
                expect(
                    ts
                        .getPreEmitDiagnostics(program)
                        .map((d) =>
                            ts.flattenDiagnosticMessageText(
                                d.messageText,
                                "\n",
                            ),
                        ),
                ).toEqual([]);
            });
        }
    }
    it("stages neither before-images nor scoring metadata", () => {
        const entry = manifest.entries[0]!;
        const c = byId.get(entry.id)!;
        const files: Record<string, string> = {};
        for (const p of filesUnder(`${entry.casePath}/tree`)) {
            files[`${resolve(entry.casePath)}/tree/${p}`] = readFileSync(
                `${entry.casePath}/tree/${p}`,
                "utf8",
            );
        }
        const vol = Volume.fromJSON(files);
        stageCase(
            {...c, sourcePath: resolve(entry.casePath, "case.json")},
            `/stage/${c.id}`,
            volFs(vol),
        );
        const staged = vol.toJSON(`/stage/${c.id}`);
        expect(
            Object.keys(staged).some(
                (p) =>
                    p.includes("/before/") ||
                    p.endsWith("/case.json") ||
                    p.includes("manifest"),
            ),
        ).toBe(false);
        const context = Object.entries(staged)
            .filter(([p]) => p.includes("/context/"))
            .map(([, body]) => body)
            .join("\n");
        expect(context).not.toContain(entry.name);
        expect(context).not.toContain("mustCatchSpecs");
        expect(context).not.toContain("negativeWitnesses");
    });
    it("contains only independently authored TypeScript, not private source", () => {
        for (const entry of manifest.entries) {
            expect(entry.kind).toBe("authored");
            expect(entry.provenance.origin).toBe("authored");
            expect(
                Object.keys(entry.tree).every((p) => p.endsWith(".ts")),
            ).toBe(true);
            expect(entry.provenance).toEqual({
                origin: "authored",
                notHistorical: true,
            });
        }
    });
});
