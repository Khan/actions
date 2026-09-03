import {spawnSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PREAMBLE_END = "<!-- END CANARY PREAMBLE -->\n";
export const REVIEW_PROMPT_HEADER = "# PR Reviewer\n";

export const bodyOf = (markdown: string): string => {
    const close = markdown.indexOf("\n---\n", 3);
    if (close === -1) {
        throw new Error("No frontmatter closing delimiter found");
    }
    return markdown.slice(close + "\n---\n".length);
};

export const after = (text: string, needle: string): string => {
    const at = text.indexOf(needle);
    if (at === -1) {
        throw new Error(`Expected to find ${JSON.stringify(needle)}`);
    }
    return text.slice(at + needle.length);
};

export const deriveCanaryMarkdown = (
    reviewMd: string,
    existingCanaryMd: string,
): string => {
    const preambleIdx = existingCanaryMd.indexOf(PREAMBLE_END);
    if (preambleIdx === -1) {
        throw new Error(
            `Canary preamble terminator (${PREAMBLE_END.trim()}) not found`,
        );
    }
    const canaryHeaderAndPreamble = existingCanaryMd.slice(
        0,
        preambleIdx + PREAMBLE_END.length,
    );

    const sourceMatch = reviewMd.match(/^source:.*$/m);
    if (!sourceMatch) {
        throw new Error("No source: provenance line found in review.md");
    }

    const updatedHeader = canaryHeaderAndPreamble.replace(
        /^source:.*$/m,
        sourceMatch[0],
    );

    const reviewPrompt = after(bodyOf(reviewMd), REVIEW_PROMPT_HEADER);
    return updatedHeader + reviewPrompt;
};

export const findGhAwBinary = (): string | null => {
    if (process.env.GH_AW_BIN && fs.existsSync(process.env.GH_AW_BIN)) {
        return process.env.GH_AW_BIN;
    }
    const localExtension = path.join(
        os.homedir(),
        ".local/share/gh/extensions/gh-aw/gh-aw",
    );
    if (fs.existsSync(localExtension)) {
        return localExtension;
    }
    const checkPath = spawnSync("which", ["gh-aw"], {encoding: "utf-8"});
    if (checkPath.status === 0 && checkPath.stdout.trim()) {
        return checkPath.stdout.trim();
    }
    return null;
};

export const compileCanaryLock = (repoRoot: string): boolean => {
    const ghAw = findGhAwBinary();
    const gitattributesPath = path.join(repoRoot, ".gitattributes");
    const gitattributesBefore = fs.existsSync(gitattributesPath)
        ? fs.readFileSync(gitattributesPath, "utf-8")
        : null;

    let res;
    if (ghAw) {
        res = spawnSync(ghAw, ["compile", "review-canary"], {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: "inherit",
        });
    } else {
        res = spawnSync("gh", ["aw", "compile", "review-canary"], {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: "inherit",
        });
    }

    if (gitattributesBefore !== null && fs.existsSync(gitattributesPath)) {
        const gitattributesAfter = fs.readFileSync(gitattributesPath, "utf-8");
        if (gitattributesAfter !== gitattributesBefore) {
            fs.writeFileSync(gitattributesPath, gitattributesBefore, "utf-8");
        }
    }

    return res.status === 0;
};

export const generateCanary = (options: {compile?: boolean} = {}): void => {
    const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
    const reviewPath = path.join(repoRoot, ".github/workflows/review.md");
    const canaryPath = path.join(
        repoRoot,
        ".github/workflows/review-canary.md",
    );

    const reviewMd = fs.readFileSync(reviewPath, "utf-8");
    const currentCanaryMd = fs.readFileSync(canaryPath, "utf-8");

    const nextCanaryMd = deriveCanaryMarkdown(reviewMd, currentCanaryMd);
    if (nextCanaryMd !== currentCanaryMd) {
        fs.writeFileSync(canaryPath, nextCanaryMd, "utf-8");
        console.log(
            "Updated .github/workflows/review-canary.md from review.md",
        );
    } else {
        console.log(
            ".github/workflows/review-canary.md is already up to date with review.md",
        );
    }

    if (options.compile !== false) {
        console.log("Compiling .github/workflows/review-canary.lock.yml...");
        const ok = compileCanaryLock(repoRoot);
        if (!ok) {
            throw new Error(
                "Failed to compile review-canary.lock.yml with gh-aw",
            );
        }
    }
};
