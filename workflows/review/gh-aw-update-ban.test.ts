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
 * `.changeset/` is excluded (transient release notes describing the ban) and
 * `gh-aw-review-lib/` is a runtime checkout, never tracked.
 */
import {spawnSync} from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {describe, expect, it} from "vitest";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");

/**
 * Files allowed to mention the tool, every one prohibitively: the ban's own
 * section in the bump skill, the two onboarding-skill warnings, the consumer
 * README's warning, and review-pins.test.ts's doc comments about why the
 * pins need a backstop at all.
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
        const ls = spawnSync("git", ["ls-files", "*.md", "*.ts"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(ls.status).toBe(0);
        const offenders = ls.stdout
            .split("\n")
            .filter(
                (file) =>
                    file !== "" &&
                    !file.startsWith(".changeset/") &&
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
