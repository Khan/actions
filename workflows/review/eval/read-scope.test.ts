import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {outOfScopeRead, readScopeReason} from "./read-scope";

/**
 * A lexical realpath for the pure cases: every path "exists" and nothing is
 * a symlink, so the predicate is exercised without touching the disk.
 */
const lexical = (p: string): string => p;

const ROOT = "/stage/candidate/case-1";
const CWD = `${ROOT}/checkout`;

const inScope = (tool: string, input: unknown): string | undefined =>
    outOfScopeRead(tool, input, ROOT, CWD, {realpath: lexical});

describe("outOfScopeRead", () => {
    it("allows reads inside the checkout and its context sibling", () => {
        expect(inScope("Read", {file_path: `${CWD}/src/a.ts`})).toBeUndefined();
        expect(
            inScope("Read", {file_path: `${ROOT}/context/pr.diff`}),
        ).toBeUndefined();
        expect(inScope("Grep", {pattern: "x", path: CWD})).toBeUndefined();
        expect(
            inScope("Glob", {pattern: "**/*.ts", path: `${ROOT}/context`}),
        ).toBeUndefined();
    });

    it("resolves relative paths against the cwd", () => {
        expect(inScope("Read", {file_path: "src/a.ts"})).toBeUndefined();
        expect(
            inScope("Read", {file_path: "../context/pr.diff"}),
        ).toBeUndefined();
        expect(inScope("Read", {file_path: "../../../../etc/passwd"})).toBe(
            "/etc/passwd",
        );
    });

    it("treats a missing path field as the cwd (in scope)", () => {
        expect(inScope("Grep", {pattern: "x"})).toBeUndefined();
        expect(inScope("Glob", {pattern: "**/*.ts"})).toBeUndefined();
        expect(inScope("Read", {})).toBeUndefined();
    });

    it("names the resolved path of an out-of-scope read", () => {
        const repo = "/home/runner/work/actions/actions";
        expect(
            inScope("Read", {
                file_path: `${repo}/workflows/review/eval/corpus/live/case-1/case.json`,
            }),
        ).toBe(`${repo}/workflows/review/eval/corpus/live/case-1/case.json`);
        expect(inScope("Grep", {pattern: "mustCatch", path: repo})).toBe(repo);
        expect(inScope("Glob", {pattern: "**/case.json", path: "/"})).toBe("/");
    });

    it("denies a sibling stage dir (another case, or the other arm)", () => {
        expect(
            inScope("Read", {
                file_path: "/stage/candidate/case-2/context/pr.diff",
            }),
        ).toBe("/stage/candidate/case-2/context/pr.diff");
        expect(
            inScope("Read", {
                file_path: "/stage/baseline/case-1/context/pr.diff",
            }),
        ).toBe("/stage/baseline/case-1/context/pr.diff");
        // A prefix that is not a path prefix.
        expect(inScope("Read", {file_path: `${ROOT}-b/x`})).toBe(`${ROOT}-b/x`);
    });

    it("judges a glob pattern by where its literal prefix lands", () => {
        expect(inScope("Glob", {pattern: "/**/case.json"})).toBe(
            "/**/case.json",
        );
        expect(inScope("Glob", {pattern: "../../**/live-match.ts"})).toBe(
            "../../**/live-match.ts",
        );
        expect(inScope("Glob", {pattern: "src/**/..*"})).toBeUndefined();
        // Climbing to the context sibling is inside the root: allowed.
        expect(inScope("Glob", {pattern: "../context/*.diff"})).toBeUndefined();
        // Climbing past the root is not.
        expect(inScope("Glob", {pattern: "../../case-2/**"})).toBe(
            "../../case-2/**",
        );
        // A `..` after a glob segment cannot be resolved: denied.
        expect(inScope("Glob", {pattern: "*/../../etc/*"})).toBe(
            "*/../../etc/*",
        );
        // Brace alternation: any alternative that escapes denies the pattern.
        expect(inScope("Glob", {pattern: "{/**,src}/case.json"})).toBe(
            "{/**,src}/case.json",
        );
        expect(inScope("Glob", {pattern: "{../..,src}/live-match.ts"})).toBe(
            "{../..,src}/live-match.ts",
        );
        expect(inScope("Glob", {pattern: "src/{a,b}/**/*.ts"})).toBeUndefined();
        expect(inScope("Glob", {pattern: "**/*.{ts,tsx}"})).toBeUndefined();
        // Past the expansion cap the pattern cannot be checked: denied.
        const wide = `{${"a,".repeat(20)}b}`;
        const blowup = `${wide}/${wide}/${wide}/*.ts`;
        expect(inScope("Glob", {pattern: blowup})).toBe(blowup);
        // The base path is checked before the pattern.
        expect(inScope("Glob", {pattern: "*.ts", path: "/etc"})).toBe("/etc");
    });

    it("leaves unknown tools and malformed input alone", () => {
        expect(inScope("Bash", {command: "cat /etc/passwd"})).toBeUndefined();
        expect(inScope("Read", null)).toBeUndefined();
        expect(inScope("Read", {file_path: 42})).toBeUndefined();
        expect(inScope("Read", {file_path: ""})).toBeUndefined();
    });
});

describe("outOfScopeRead on a real filesystem", () => {
    let base: string;
    let root: string;
    let outside: string;

    beforeAll(() => {
        base = mkdtempSync(join(tmpdir(), "read-scope-"));
        root = join(base, "stage", "case");
        outside = join(base, "repo");
        mkdirSync(join(root, "checkout", "src"), {recursive: true});
        mkdirSync(join(root, "context"), {recursive: true});
        mkdirSync(outside, {recursive: true});
        writeFileSync(join(outside, "case.json"), "{}");
        writeFileSync(join(root, "checkout", "src", "a.ts"), "");
        // A symlink planted inside the checkout that points at the repo.
        symlinkSync(outside, join(root, "checkout", "escape"));
    });

    afterAll(() => {
        rmSync(base, {recursive: true, force: true});
    });

    it("follows a symlink out of the root and denies it", () => {
        const cwd = join(root, "checkout");
        const hit = outOfScopeRead(
            "Read",
            {file_path: join(cwd, "escape", "case.json")},
            root,
            cwd,
        );
        expect(hit).toBeDefined();
        expect(hit).toMatch(/repo[\\/]case\.json$/);
        expect(hit).not.toContain("escape");
    });

    it("allows a real file inside the root", () => {
        const cwd = join(root, "checkout");
        expect(
            outOfScopeRead("Read", {file_path: "src/a.ts"}, root, cwd),
        ).toBeUndefined();
    });

    it("checks a path that does not exist yet by its existing ancestor", () => {
        const cwd = join(root, "checkout");
        expect(
            outOfScopeRead("Read", {file_path: "src/missing.ts"}, root, cwd),
        ).toBeUndefined();
        expect(
            outOfScopeRead(
                "Read",
                {file_path: join(outside, "nope", "deeper.ts")},
                root,
                cwd,
            ),
        ).toBe(join(realpathSync.native(outside), "nope", "deeper.ts"));
    });
});

describe("readScopeReason", () => {
    it("names the target and the scope", () => {
        const reason = readScopeReason(ROOT, "/etc/passwd");
        expect(reason).toContain("/etc/passwd");
        expect(reason).toContain(ROOT);
    });
});
