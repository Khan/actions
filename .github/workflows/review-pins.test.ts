/**
 * CI backstop for the pins in this repo's installed reviewer (review.md here,
 * distinct from the shared source at workflows/review/review.md).
 *
 * The install carries coupled pins that no release automation touches:
 * `source:`, recording which Khan/actions release the prompt was copied from,
 * the `ref:` of the gh-aw-review-lib checkout that fetches the deterministic
 * lib the prompt invokes at runtime, and the copies of both that `gh aw
 * compile` bakes into review.lock.yml (which is what actually executes, and
 * which .gitattributes marks merge=ours, so a merge can silently keep a stale
 * lock). If a future `gh aw update`, a hand edit, or a skipped recompile moves
 * one without the others, the prompt from one release runs the lib of another;
 * this test fails that PR. (The shared source's own ref is kept true by
 * utils/sync-workflow-versions.ts and its backstop in
 * workflows/review/version-sync.test.ts; neither covers these files.)
 */
import {spawnSync} from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {describe, expect, it} from "vitest";

const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);
const reviewLock = fs.readFileSync(
    new URL("./review.lock.yml", import.meta.url),
    "utf-8",
);

const sourceRef = reviewMd.match(
    /^source:\s*Khan\/actions\/workflows\/review\/review\.md@(\S+)\s*$/m,
)?.[1];
const checkoutRefs = [...reviewMd.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map(
    (m) => m[1],
);

describe("installed review.md pins", () => {
    it("records the review release the prompt was copied from", () => {
        expect(sourceRef).toMatch(/^review-v\d+\.\d+\.\d+$/);
    });

    it("checks out the lib at exactly the source: release", () => {
        expect(checkoutRefs).toEqual([sourceRef]);
    });

    it("names no other release anywhere in the file", () => {
        const literals = reviewMd.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([sourceRef]));
    });
});

describe("compiled review.lock.yml pins", () => {
    it("was recompiled from this review.md (every baked literal matches)", () => {
        const literals = reviewLock.match(/review-v\d+\.\d+\.\d+/g) ?? [];
        expect(literals.length).toBeGreaterThan(0);
        expect(new Set(literals)).toEqual(new Set([sourceRef]));
    });
});

/**
 * Content guard for the hand-merged install. `gh aw update` cannot resolve
 * changesets-style tags (review-v*), so bumps of the installed copy are
 * manual 3-way merges; the pins above check version consistency but nothing
 * verified the merged CONTENT. This diffs the installed copy against the
 * shared source at the pinned release (this repo hosts both) and requires
 * every hunk to carry a `KHAN/ACTIONS LOCAL OVERRIDE` marker, so a manual
 * bump that silently drops an override or an upstream hunk fails CI instead
 * of surfacing in a live run. Convention enforced as a side effect: each
 * override edit inserts its marker comment adjacent to the edited lines
 * (within the diff hunk's context window).
 */
describe("installed review.md content vs the pinned source", () => {
    const repoRoot = path.resolve(
        new URL(".", import.meta.url).pathname,
        "../..",
    );
    const sourcePath = "workflows/review/review.md";

    const gitShow = (ref: string): string | null => {
        const show = () =>
            spawnSync("git", ["show", `${ref}:${sourcePath}`], {
                cwd: repoRoot,
                encoding: "utf-8",
                maxBuffer: 32 * 1024 * 1024,
            });
        let result = show();
        if (result.status !== 0) {
            // A shallow or tag-less clone (CI checks out at depth 1): fetch
            // just the pinned tag, then retry.
            spawnSync(
                "git",
                ["fetch", "--quiet", "--depth=1", "origin", "tag", ref],
                {cwd: repoRoot, encoding: "utf-8"},
            );
            result = show();
        }
        return result.status === 0 ? result.stdout : null;
    };

    it("differs from the pinned release only inside LOCAL OVERRIDE hunks", () => {
        expect(sourceRef).toBeDefined();
        const source = gitShow(sourceRef as string);
        if (source === null) {
            throw new Error(
                `cannot read ${sourcePath} at tag ${sourceRef}: fetch the ` +
                    `tag (git fetch origin tag ${sourceRef}) and re-run`,
            );
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-pins-"));
        try {
            const sourceFile = path.join(dir, "source.md");
            fs.writeFileSync(sourceFile, source);
            const installedFile = path.join(dir, "installed.md");
            fs.writeFileSync(installedFile, reviewMd);
            const diff = spawnSync("diff", ["-u", sourceFile, installedFile], {
                encoding: "utf-8",
                maxBuffer: 32 * 1024 * 1024,
            });
            // 0: identical, 1: differences found, 2: trouble.
            expect([0, 1]).toContain(diff.status);
            const hunks: string[][] = [];
            for (const line of diff.stdout.split("\n")) {
                if (line.startsWith("@@")) {
                    hunks.push([line]);
                } else {
                    hunks.at(-1)?.push(line);
                }
            }
            const unmarked = hunks.filter(
                (hunk) =>
                    !hunk.some((line) =>
                        line.includes("KHAN/ACTIONS LOCAL OVERRIDE"),
                    ),
            );
            expect(
                unmarked.map((hunk) => hunk.slice(0, 8).join("\n")),
            ).toEqual([]);
        } finally {
            fs.rmSync(dir, {recursive: true, force: true});
        }
    });
});
