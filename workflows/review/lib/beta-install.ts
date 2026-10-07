/**
 * Pairing checks for a beta install: a second copy of the reviewer at
 * `.github/workflows/review-beta.md`, pinned to a candidate release, that
 * reviews only PRs whose author is in the `REVIEW_BETA_AUTHORS` repo variable
 * while the stable install reviews everyone else (README, "Beta testers").
 * Split out of `check-consumer-config.ts` because it reads two installs at
 * once, where the rest of the checker validates one.
 *
 * Every failure here is silent until a PR hits it: an ungated install
 * double-reviews, an unguarded `fromJSON` fails every run while the variable
 * is unset, and equal workflow names share one concurrency group, where the
 * run about to skip cancels the live one. The variable's value is not
 * visible from a checkout, so only the expressions are checked.
 */
import type {ConfigIssue, ConsumerConfigFs} from "./check-consumer-config";
import {
    frontmatterBlock,
    nested,
    scalar,
    stripInlineComment,
    unquote,
    yamlLines,
} from "./frontmatter";

export const BETA_WORKFLOW_PATH = ".github/workflows/review-beta.md";
export const BETA_LOCK_PATH = ".github/workflows/review-beta.lock.yml";
export const BETA_AUTHORS_VAR = "REVIEW_BETA_AUTHORS";

const PR_AUTHOR = "github.event.pull_request.user.login";
const ISSUE_AUTHOR = "github.event.issue.user.login";

export type BetaGate = {
    negated: boolean;
    guarded: boolean;
    author: string;
};

const GATE_RE = new RegExp(
    String.raw`(!\s*)?contains\(\s*fromJSON\(\s*vars\.${BETA_AUTHORS_VAR}\s*(\|\|\s*'\[\]'\s*)?\)\s*,\s*([^)]*?)\s*\)`,
    "g",
);
const UNGUARDED_RE = new RegExp(
    String.raw`vars\.${BETA_AUTHORS_VAR}(?!\s*\|\|\s*'\[\]')`,
);

export const workflowCondition = (block: string): string | undefined => {
    const lines = block.split(/\r?\n/);
    const start = lines.findIndex((line) => /^if:/.test(line));
    if (start === -1) {
        return undefined;
    }
    const inline = stripInlineComment(lines[start].slice("if:".length)).trim();
    if (!/^[>|]/.test(inline)) {
        return inline === "" ? undefined : unquote(inline);
    }
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() !== "" && !/^\s/.test(line)) {
            break;
        }
        body.push(line.trim());
    }
    const joined = body.filter((line) => line !== "").join(" ");
    return joined === "" ? undefined : joined;
};

export const betaGates = (condition: string): BetaGate[] =>
    [...condition.matchAll(GATE_RE)].map((match) => ({
        negated: match[1] !== undefined,
        guarded: match[2] !== undefined,
        author: match[3],
    }));

export const lockWorkflowName = (lock: string): string | undefined => {
    const match = /^name:\s*(.+)$/m.exec(lock);
    return match === null ? undefined : unquote(match[1]);
};

type Install = {
    path: string;
    lockPath: string;
    condition?: string;
    commentTriggered: boolean;
    pinnedRef?: string;
    lockName?: string;
    lockPresent: boolean;
};

const readInstall = (
    fs: ConsumerConfigFs,
    at: (p: string) => string,
    path: string,
    lockPath: string,
): Install | undefined => {
    if (!fs.existsSync(at(path))) {
        return undefined;
    }
    const block = frontmatterBlock(fs.readFileSync(at(path), "utf8")) ?? "";
    const lines = yamlLines(block);
    const source = scalar(lines, "source");
    const atIndex = source?.lastIndexOf("@") ?? -1;
    const lockPresent = fs.existsSync(at(lockPath));
    return {
        path,
        lockPath,
        condition: workflowCondition(block),
        commentTriggered:
            nested(lines, "on")?.some((line) => line.key === "issue_comment") ??
            false,
        pinnedRef:
            source !== undefined && atIndex > 0
                ? source.slice(atIndex + 1)
                : undefined,
        lockName: lockPresent
            ? lockWorkflowName(fs.readFileSync(at(lockPath), "utf8"))
            : undefined,
        lockPresent,
    };
};

const gateIssues = (
    install: Install,
    role: "stable" | "beta",
): ConfigIssue[] => {
    const issues: ConfigIssue[] = [];
    const negated = role === "stable";
    const clause = `${
        negated ? "!" : ""
    }contains(fromJSON(vars.${BETA_AUTHORS_VAR} || '[]'), ${PR_AUTHOR} || ${ISSUE_AUTHOR})`;
    const gates = betaGates(install.condition ?? "");
    if (gates.length === 0) {
        issues.push({
            severity: "error",
            code: "beta-gate-missing",
            message:
                role === "stable"
                    ? `${install.path}'s \`if:\` does not exclude ${BETA_AUTHORS_VAR}, so beta authors' PRs are reviewed by both installs.`
                    : `${install.path}'s \`if:\` does not gate on ${BETA_AUTHORS_VAR}, so the beta install reviews every PR alongside the stable one.`,
            fix: `AND \`${clause}\` into every branch of the \`if:\`.`,
        });
        return issues;
    }
    if (gates.some((gate) => gate.negated !== negated)) {
        issues.push({
            severity: "error",
            code: "beta-gate-polarity",
            message: `${
                install.path
            } is the ${role} install, but a ${BETA_AUTHORS_VAR} clause in its \`if:\` ${
                negated ? "selects" : "excludes"
            } beta authors, so some PRs get both installs or neither.`,
            fix: `Use \`${clause}\`.`,
        });
    }
    if (
        install.condition !== undefined &&
        UNGUARDED_RE.test(install.condition)
    ) {
        issues.push({
            severity: "error",
            code: "beta-gate-unguarded",
            message: `${install.path} reads \`vars.${BETA_AUTHORS_VAR}\` without \`|| '[]'\`: \`fromJSON('')\` is an expression error, so every run fails while the variable is unset.`,
            fix: `Write \`fromJSON(vars.${BETA_AUTHORS_VAR} || '[]')\`.`,
        });
    }
    const missingAuthor = gates.some(
        (gate) =>
            !gate.author.includes(PR_AUTHOR) ||
            (install.commentTriggered && !gate.author.includes(ISSUE_AUTHOR)),
    );
    if (missingAuthor) {
        issues.push({
            severity: "error",
            code: "beta-gate-author",
            message: install.commentTriggered
                ? `${install.path} has an \`issue_comment\` trigger, but a ${BETA_AUTHORS_VAR} clause does not read the PR author as \`${PR_AUTHOR} || ${ISSUE_AUTHOR}\`; on a comment event \`pull_request\` is absent, so a \`/review\` reaches the wrong install.`
                : `A ${BETA_AUTHORS_VAR} clause in ${install.path} does not test \`${PR_AUTHOR}\`, the PR author.`,
            fix: `Use \`${clause}\`.`,
        });
    }
    return issues;
};

export const betaInstallIssues = (
    fs: ConsumerConfigFs,
    at: (p: string) => string,
    stablePaths: {path: string; lockPath: string},
    checkedPath: string,
): ConfigIssue[] => {
    const beta = readInstall(fs, at, BETA_WORKFLOW_PATH, BETA_LOCK_PATH);
    if (beta === undefined) {
        return [];
    }
    const issues: ConfigIssue[] = [];
    const stable = readInstall(fs, at, stablePaths.path, stablePaths.lockPath);
    if (stable === undefined) {
        issues.push({
            severity: "error",
            code: "beta-without-stable",
            message: `${BETA_WORKFLOW_PATH} exists but ${stablePaths.path} does not, so PRs by authors outside ${BETA_AUTHORS_VAR} are never reviewed.`,
            fix: 'Restore the stable install, or graduate the beta (README, "Beta testers").',
        });
    } else {
        issues.push(...gateIssues(stable, "stable"));
    }
    issues.push(...gateIssues(beta, "beta"));
    if (!beta.lockPresent && checkedPath !== BETA_WORKFLOW_PATH) {
        issues.push({
            severity: "error",
            code: "beta-lock-missing",
            message: `${BETA_LOCK_PATH} is missing, so the beta install never runs and beta authors' PRs go unreviewed.`,
            fix: "Run `gh aw compile` and commit the lock.",
        });
    }
    if (
        stable !== undefined &&
        !stable.lockPresent &&
        checkedPath !== stablePaths.path
    ) {
        issues.push({
            severity: "error",
            code: "stable-lock-missing",
            message: `${stablePaths.lockPath} is missing, so the stable install never runs and only beta authors' PRs are reviewed.`,
            fix: "Run `gh aw compile` and commit the lock.",
        });
    }
    if (
        stable?.lockName !== undefined &&
        beta.lockName !== undefined &&
        stable.lockName === beta.lockName
    ) {
        issues.push({
            severity: "error",
            code: "beta-name-collision",
            message: `Both locks run as "${beta.lockName}". The concurrency group is keyed on the workflow name and cancels in progress, and it applies before any job \`if:\`, so the install that is about to skip cancels the other's live run.`,
            fix: `Give ${BETA_WORKFLOW_PATH} its own frontmatter \`name:\` (e.g. \`name: PR Reviewer (beta)\`) and recompile.`,
        });
    }
    if (
        stable?.pinnedRef !== undefined &&
        stable.pinnedRef === beta.pinnedRef
    ) {
        issues.push({
            severity: "warning",
            code: "beta-same-pin",
            message: `${BETA_WORKFLOW_PATH} pins ${beta.pinnedRef}, the same release as ${stablePaths.path}, so beta authors get no different reviewer.`,
            fix: "Pin the beta to the candidate release, or graduate and remove it.",
        });
    }
    return issues;
};
