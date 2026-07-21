import {execFileSync} from "node:child_process";
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
 * section of review.md's main body, which Step 1 stages to
 * `/tmp/gh-aw/review/disciplines.md` with a mechanical `sed` range extraction.
 *
 * These tests pin the contract: the section exists and extracts cleanly (the
 * same line-range semantics the sed command uses), it carries every section
 * the lens pointer names, each lens definition points at the staged file and
 * no longer carries its own copy, and the label-shape reviewers (whose
 * variants differ materially) still carry theirs.
 */

const reviewMdPath = join(__dirname, "..", "review.md");
const reviewMd = readFileSync(reviewMdPath, "utf8");

const BEGIN = "<!-- BEGIN REVIEW DISCIPLINES -->";
const END = "<!-- END REVIEW DISCIPLINES -->";

/**
 * The exact sed range expression review.md Step 1 runs (whole-line anchored).
 * The anchors are load-bearing: without `^...$`, the range would open at the
 * first backticked *mention* of the marker in the prose, ~1075 lines early.
 */
const SED_RANGE = `/^${BEGIN}$/,/^${END}$/p`;

/**
 * The sed range extraction from review.md Step 1, replicated line-for-line.
 * The Step 1 command anchors both patterns to whole lines (`^...$`), so only
 * the marker lines themselves open/close the range — never prose that mentions
 * a marker, and never the sed command's own text.
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

    it("is staged by Step 1 with the sed extraction and a fallback guard", () => {
        expect(mainBody).toContain("$GH_AW_PROMPT");
        expect(mainBody).toContain("/tmp/gh-aw/review/disciplines.md");
        expect(mainBody).toContain(
            "grep -q '## Structured finding schema and hunts'",
        );
    });

    it("extracts identically under real sed (not only the modeled replica)", () => {
        // The replica above models the sed semantics; this runs the real
        // thing, so a drift in the Step 1 command (say, dropped `^...$`
        // anchors) fails here even if the model still passes. Pin the range
        // expression to the one review.md actually documents, then run it
        // against the real file.
        expect(mainBody).toContain(`sed -n '${SED_RANGE}'`);
        const staged = execFileSync("sed", ["-n", SED_RANGE, reviewMdPath], {
            encoding: "utf8",
        });
        // sed prints each selected line with its newline; the replica joins
        // without a trailing one.
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
            // The per-lens consumer payload seam: optional, resolves to
            // nothing when the host repo carries no payload file.
            expect(section).toContain(
                `{{#runtime-import? .github/aw/review/lenses/${lens}.md}}`,
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
