/**
 * CI backstop for the `gh aw update` ban (the tool repins `review-v*` tags to
 * main's head SHA and once emptied an installed `review.md` to 0 bytes; see
 * `.claude/skills/review-consumer-bump/SKILL.md`). The ban lives entirely in
 * prose, which no automation touches, so nothing but this test stops a future
 * doc edit from recommending the tool again. Same shape as the repo's other
 * untouched-by-automation backstops (review-pins.test.ts, the cache-miss
 * guard): every tracked mention must sit in a file known to talk ABOUT the
 * ban, and a mention anywhere else fails red so the author reads the skill
 * before re-recommending.
 *
 * Known limit: the allowlist is file-granular. It catches the ban RELOCATING
 * (a mention appearing in a new file) but not a recommending sentence added
 * to a file already allowed to mention the tool; that stays a review-time
 * judgment. Excluded from the sweep entirely: `.changeset/` and the package
 * CHANGELOG.md files (changeset bodies describing the ban are copied
 * verbatim into the CHANGELOG at `changeset version`, so both carry the
 * phrase legitimately and transiently grow), and the eval corpus (case
 * fixtures quote arbitrary text; vitest.config.ts already carves out its
 * tree/ dirs for the same reason).
 */
import {spawnSync} from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {describe, expect, it} from "vitest";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");

/**
 * Files allowed to mention the tool: the ban's own section in the bump skill,
 * the two onboarding-skill warnings, the consumer README's warning,
 * review-pins.test.ts's doc comments about why the pins need a backstop at
 * all, and this file, which carries the search string itself (the one
 * non-prohibitive mention).
 */
const ALLOWED = new Set([
    ".claude/skills/review-consumer-bump/SKILL.md",
    ".claude/skills/review-onboarding/SKILL.md",
    ".github/workflows/review-pins.test.ts",
    "workflows/review/README.md",
    "workflows/review/gh-aw-update-ban.test.ts",
]);

describe("the gh aw update ban", () => {
    it("is mentioned only where it is being banned", () => {
        // Every tracked file, not an extension list: the ban's residue has
        // already turned up in .md prose, .ts warning strings, and a
        // compiled .lock.yml, so an extension filter is just a bet on where
        // the next one lands. Reading a binary as utf8 cannot match the
        // phrase, so no file type needs excluding for safety.
        const ls = spawnSync("git", ["ls-files"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(ls.status).toBe(0);
        const offenders = ls.stdout.split("\n").filter(
            (file) =>
                file !== "" &&
                !file.startsWith(".changeset/") &&
                // `changeset version` copies each changeset body verbatim
                // into the package CHANGELOG.md, so the released notes
                // inherit whatever mentions .changeset/ was excused for.
                !file.endsWith("CHANGELOG.md") &&
                !file.startsWith("workflows/review/eval/corpus/") &&
                !ALLOWED.has(file) &&
                fs
                    .readFileSync(path.join(repoRoot, file), "utf8")
                    .includes("gh aw update"),
        );
        expect(offenders).toEqual([]);
    });

    it("keeps every allowlisted file actually mentioning it (stale allowlist detector)", () => {
        for (const file of ALLOWED) {
            expect(
                fs.readFileSync(path.join(repoRoot, file), "utf8"),
                `${file} no longer mentions the tool; prune it from ALLOWED`,
            ).toContain("gh aw update");
        }
    });
});
