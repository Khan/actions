import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {describe, expect, it} from "vitest";
import {
    PREAMBLE_END,
    REVIEW_PROMPT_HEADER,
    compileCanaryLock,
    deriveCanaryMarkdown,
    findGhAwBinary,
} from "./generate-canary-lib.ts";

describe("deriveCanaryMarkdown", () => {
    it("splices review.md's source line and prompt body onto canary's preamble", () => {
        const canaryPreamble = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v1.0.0",
            "---",
            "",
            "# PR Reviewer Canary",
            "",
            "Canary instructions.",
            "",
            PREAMBLE_END,
            "old prompt body that should be replaced",
        ].join("\n");

        const reviewMd = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "new shared prompt body verbatim",
        ].join("\n");

        const result = deriveCanaryMarkdown(reviewMd, canaryPreamble);

        expect(result).toContain(
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
        );
        expect(result).not.toContain("review-v1.0.0");
        expect(result).toContain("Canary instructions.");
        expect(result).toContain(PREAMBLE_END);
        expect(result).toContain("new shared prompt body verbatim");
        expect(result).not.toContain("old prompt body that should be replaced");
    });

    it("throws if the canary preamble end marker is missing", () => {
        const invalidCanary = "no preamble end marker here";
        const reviewMd = [
            "---",
            "source: Khan/actions/workflows/review/review.md@review-v2.0.0",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "prompt",
        ].join("\n");

        expect(() => deriveCanaryMarkdown(reviewMd, invalidCanary)).toThrow(
            /Canary preamble terminator/,
        );
    });

    it("throws if review.md has no source line", () => {
        const canaryMd = ["---", "source: test", "---", PREAMBLE_END].join(
            "\n",
        );
        const reviewMd = [
            "---",
            "no-source-line: true",
            "---",
            "",
            REVIEW_PROMPT_HEADER,
            "prompt",
        ].join("\n");

        expect(() => deriveCanaryMarkdown(reviewMd, canaryMd)).toThrow(
            /No source: provenance line/,
        );
    });
});

describe("findGhAwBinary", () => {
    it("returns a path or null", () => {
        const bin = findGhAwBinary();
        expect(bin === null || typeof bin === "string").toBe(true);
    });
});

describe("compileCanaryLock", () => {
    it("throws when local gh-aw version does not match compiler_version in lock", () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
        try {
            const workflowDir = path.join(repoRoot, ".github/workflows");
            fs.mkdirSync(workflowDir, {recursive: true});
            const lockPath = path.join(workflowDir, "review-canary.lock.yml");
            fs.writeFileSync(
                lockPath,
                '# gh-aw-metadata: {"compiler_version":"v0.85.4"}\n',
                "utf-8",
            );

            const fakeGhAw = path.join(repoRoot, "fake-gh-aw");
            fs.writeFileSync(
                fakeGhAw,
                '#!/bin/sh\nif [ "$1" = "version" ]; then echo "gh aw version v0.99.0"; fi\n',
                "utf-8",
            );
            fs.chmodSync(fakeGhAw, 0o755);

            const prev = process.env.GH_AW_BIN;
            process.env.GH_AW_BIN = fakeGhAw;
            try {
                expect(() => compileCanaryLock(repoRoot)).toThrow(
                    /Local gh-aw v0.99.0 differs from the v0.85.4/,
                );
            } finally {
                if (prev === undefined) {
                    delete process.env.GH_AW_BIN;
                } else {
                    process.env.GH_AW_BIN = prev;
                }
            }
        } finally {
            fs.rmSync(repoRoot, {recursive: true, force: true});
        }
    });

    it("restores .gitattributes when gh-aw compile rewrites it", () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canary-test-"));
        try {
            const gitattributes = path.join(repoRoot, ".gitattributes");
            const original =
                ".github/workflows/*.lock.yml linguist-generated=true merge=ours\n";
            fs.writeFileSync(gitattributes, original, "utf-8");

            const fakeGhAw = path.join(repoRoot, "fake-gh-aw");
            fs.writeFileSync(
                fakeGhAw,
                '#!/bin/sh\nif [ "$1" = "version" ]; then echo "gh aw version v0.85.4"; exit 0; fi\n' +
                    'echo "stripped" > "$(dirname "$0")/.gitattributes"\nexit 0\n',
                "utf-8",
            );
            fs.chmodSync(fakeGhAw, 0o755);

            const prev = process.env.GH_AW_BIN;
            process.env.GH_AW_BIN = fakeGhAw;
            try {
                expect(compileCanaryLock(repoRoot)).toBe(true);
                expect(fs.readFileSync(gitattributes, "utf-8")).toBe(original);
            } finally {
                if (prev === undefined) {
                    delete process.env.GH_AW_BIN;
                } else {
                    process.env.GH_AW_BIN = prev;
                }
            }
        } finally {
            fs.rmSync(repoRoot, {recursive: true, force: true});
        }
    });
});
