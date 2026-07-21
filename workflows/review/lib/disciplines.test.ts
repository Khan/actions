import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {SPECIALIST_LENSES} from "./router.ts";

/**
 * Dispatch-tax dedupe smoke tests.
 *
 * The measured cost premium of the v1.4.0 re-run sat at dispatch time
 * (uncached input +51-65%, cache writes +18-34% per run), partly because
 * discipline snippets (bounded investigation, quote-the-rule via lens-owned
 * skills, the schema-rules trailer, ...) were stamped verbatim into every one
 * of the eleven specialist-lens definitions and paid on every dispatch. The
 * shared text now lives once, in the marker-delimited REVIEW DISCIPLINES
 * section of review.md's main body. Since slice 3 (#247) the extraction is
 * code, not prompt: the pre-agent staging step (`stage-pr.ts`) extracts the
 * marker-delimited section from the rendered prompt and verifies the schema
 * heading before writing `/tmp/gh-aw/review/disciplines.md`; the prompt keeps
 * only the byte-for-byte heredoc fallback for a failed staging.
 *
 * These tests pin the contract: the section exists and extracts cleanly
 * under the same whole-line marker semantics the staging code uses (verified
 * against stage-pr's real extraction over the real review.md), it carries
 * every section the lens pointer names, each lens definition points at the
 * staged file and no longer carries its own copy, and the label-shape
 * reviewers (whose variants differ materially) still carry theirs.
 */

const reviewMdPath = join(__dirname, "..", "review.md");
const reviewMd = readFileSync(reviewMdPath, "utf8");

const BEGIN = "<!-- BEGIN REVIEW DISCIPLINES -->";
const END = "<!-- END REVIEW DISCIPLINES -->";

/**
 * The old Step 1 sed range semantics, replicated line-for-line: only whole
 * marker LINES open/close the range — never prose that mentions a marker.
 * The staging code (stage-pr.ts) uses `indexOf` over split lines, which is
 * the same whole-line rule; the parity test below proves it against the
 * real file.
 */
const sedRangeExtract = (text: string): string => {
    const lines = text.split("\n");
    const out: string[] = [];
    let inRange = false;
    for (const line of lines) {
        if (!inRange && line === BEGIN) {
            inRange = true;
        }
        if (inRange) {
            out.push(line);
            if (line === END) {
                break;
            }
        }
    }
    return out.join("\n");
};

/** The main body (the orchestrator prompt): everything before the first agent. */
const mainBody = reviewMd.slice(0, reviewMd.indexOf("\n## agent: `"));

/** One lens's definition section, as the sub-agent extractor would cut it. */
const lensSection = (lens: string): string => {
    const start = reviewMd.indexOf(`## agent: \`${lens}\``);
    expect(start).toBeGreaterThan(-1);
    const rest = reviewMd.slice(start);
    const next = rest.indexOf("\n## agent: `");
    return next === -1 ? rest : rest.slice(0, next);
};

const DISCIPLINE_HEADINGS = [
    "## Staged inputs",
    "## Untrusted input",
    "## Read every line",
    "## Bounded investigation",
    "## Lens-owned skills",
    "## Out-of-lane handoff",
    "## Structured finding schema and hunts",
];

describe("the shared disciplines section", () => {
    it("lives in the main body (the staged prompt), not in an agent section", () => {
        expect(mainBody).toContain(BEGIN);
        expect(mainBody).toContain(END);
    });

    it("extracts cleanly with the Step 1 sed range semantics", () => {
        const extracted = sedRangeExtract(reviewMd);
        expect(extracted.startsWith(BEGIN)).toBe(true);
        expect(extracted.endsWith(END)).toBe(true);
        for (const heading of DISCIPLINE_HEADINGS) {
            expect(extracted).toContain(`\n${heading}\n`);
        }
    });

    it("keeps the quote-the-rule discipline verbatim", () => {
        const extracted = sedRangeExtract(reviewMd);
        expect(extracted).toContain(
            "Flag a skill violation only when you can quote **both** the exact rule",
        );
        expect(extracted).toContain("no spirit-of-the-doc inference");
    });

    it("keeps the tri-state hunt contract", () => {
        const extracted = sedRangeExtract(reviewMd);
        for (const state of ["`found`", "`ran`", "`not-applicable`"]) {
            expect(extracted).toContain(state);
        }
    });

    it("is code-staged (pre-agent step) with the heredoc fallback retained", () => {
        // The extraction instruction left the prompt with slice 3 (#247);
        // what remains is the staged-path pointer and the byte-for-byte
        // fallback for a failed staging.
        expect(mainBody).toContain("/tmp/gh-aw/review/disciplines.md");
        expect(mainBody).toContain("byte-for-byte");
        expect(mainBody).not.toContain("sed -n");
    });

    it("extracts identically under stage-pr's real extraction (parity with the old sed)", async () => {
        // Run the actual staging CLI over the real review.md as the rendered
        // prompt: its output must equal the old sed range semantics, so the
        // code extraction is a drop-in for what production ran before.
        const {runStagePrCli} = await import("./stage-pr");
        const files: Record<string, string> = {
            "/tmp/gh-aw/aw-prompts/prompt.txt": reviewMd,
        };
        const fakeFs = {
            readFileSync: (p: string) => {
                if (!(p in files)) {
                    throw new Error(`ENOENT: ${p}`);
                }
                return files[p];
            },
            writeFileSync: (p: string, data: string) => {
                files[p] = data;
            },
            existsSync: (p: string) => p in files,
            mkdirSync: () => {},
        };
        await runStagePrCli(
            fakeFs,
            (path: string) =>
                Promise.resolve(
                    path.endsWith("/files?per_page=100&page=1") ||
                        path.endsWith("/reviews?per_page=100")
                        ? []
                        : {number: 1, title: "t"},
                ),
            {repo: "o/r", prNumber: 1, repoRoot: "/work"},
        );
        const staged = files["/tmp/gh-aw/review/disciplines.md"];
        expect(staged).toBe(`${sedRangeExtract(reviewMd)}\n`);
        expect(staged.startsWith(BEGIN)).toBe(true);
        for (const heading of DISCIPLINE_HEADINGS) {
            expect(staged).toContain(`\n${heading}\n`);
        }
    });
});

describe("each specialist lens definition", () => {
    for (const lens of SPECIALIST_LENSES) {
        it(`${lens}: points at the staged disciplines and carries no copy`, () => {
            const section = lensSection(lens);
            expect(section).toContain("**Shared disciplines first.**");
            expect(section).toContain("/tmp/gh-aw/review/disciplines.md");
            // The deduped blocks must be gone from the lens definition.
            expect(section).not.toContain("**Bounded investigation.**");
            expect(section).not.toContain("**Untrusted input.**");
            expect(section).not.toContain("Read from disk:");
            expect(section).not.toContain("Schema rules");
            expect(section).not.toContain(
                "**Hand off, never drop, an out-of-lane observation.**",
            );
            // The domain-specific content stays.
            expect(section).toContain("### Review rules");
            expect(section).toContain("### Incident-derived hunts (tri-state)");
            expect(section).toContain("### Output");
            expect(section).toContain(
                "{{#runtime-import .github/aw/review/skills.md}}",
            );
            expect(section).toContain(`\`lens\` is exactly \`${lens}\``);
            expect(section).toContain(
                "Domain notes for §Bounded investigation",
            );
        });
    }
});

describe("the label-shape reviewers still carry their own disciplines", () => {
    // Their variants differ materially (CLI cap invocation with per-agent id
    // semantics, `discussion` instead of `evidence_trace`), so they were
    // deliberately left out of the dedupe.
    for (const agent of [
        "correctness-reviewer",
        "skill-auditor",
        "claim-validator",
        "holistic",
        "completeness",
        "test-adequacy",
        "first-principles",
        "conventions",
    ]) {
        it(`${agent}: keeps its own bounded-investigation block`, () => {
            expect(lensSection(agent)).toContain("**Bounded investigation.**");
        });
    }
});
