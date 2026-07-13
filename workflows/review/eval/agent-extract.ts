/**
 * Sub-agent prompt extraction for the live eval arm (`live-ab-plan.md`
 * Phase 2a).
 *
 * `review.md` defines every reviewer sub-agent as a `## agent: \`name\``
 * section: YAML-ish frontmatter (`name`, `description`, `model`, plus
 * comment lines) followed by the prompt body. The live producer needs those
 * prompts as data, for BOTH arms of an A/B: the candidate arm reads the
 * working tree's `review.md`, the baseline arm reads the merge-base version
 * via `git show`. So the core function takes the markdown as a string and
 * performs no filesystem access.
 *
 * Parsing is deliberately strict: a section whose frontmatter is missing,
 * unterminated, name-mismatched, or model-less throws rather than degrading,
 * because a silently dropped agent would skew an eval arm without failing it.
 */

/** One extracted sub-agent definition. */
export type ExtractedAgent = {
    /** The agent name (heading and frontmatter must agree). */
    name: string;
    /** The frontmatter description line. */
    description: string;
    /** The pinned model id (e.g. `claude-opus-4-8`). */
    model: string;
    /** The full prompt body (everything after the frontmatter). */
    prompt: string;
};

/** Thrown when `review.md`'s agent sections cannot be parsed. */
export class AgentExtractError extends Error {
    constructor(errors: string[]) {
        super(
            `Malformed agent section(s) in review markdown:\n${errors
                .map((e) => `  - ${e}`)
                .join("\n")}`,
        );
        this.name = "AgentExtractError";
    }
}

const HEADING = /^## agent: `([^`]+)`\s*$/;

/** Parse one frontmatter block's `key: value` lines (comments ignored). */
const parseFrontmatter = (lines: string[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of lines) {
        if (line.trim() === "" || line.trim().startsWith("#")) {
            continue;
        }
        const colon = line.indexOf(":");
        if (colon === -1) {
            // A wrapped comment continuation or stray text; skip rather than
            // guess. Required keys are checked by the caller.
            continue;
        }
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.length > 0 && !out.has(key)) {
            out.set(key, value);
        }
    }
    return out;
};

/**
 * Extract every `## agent:` section from review markdown. Returns agents in
 * definition order (a Map preserves insertion order). Throws
 * {@link AgentExtractError} listing every problem at once.
 */
export const extractAgents = (
    markdown: string,
): Map<string, ExtractedAgent> => {
    const lines = markdown.split("\n");
    const agents = new Map<string, ExtractedAgent>();
    const errors: string[] = [];

    /** Indices of every agent heading, plus a sentinel end. */
    const headings: {index: number; name: string}[] = [];
    lines.forEach((line, index) => {
        const match = HEADING.exec(line);
        if (match?.[1] !== undefined) {
            headings.push({index, name: match[1]});
        }
    });

    headings.forEach((heading, i) => {
        const sectionEnd = headings[i + 1]?.index ?? lines.length;
        const at = `agent \`${heading.name}\` (line ${heading.index + 1})`;

        // Frontmatter: first non-blank line after the heading must open it.
        let cursor = heading.index + 1;
        while (cursor < sectionEnd && (lines[cursor] ?? "").trim() === "") {
            cursor++;
        }
        if ((lines[cursor] ?? "").trim() !== "---") {
            errors.push(`${at}: expected frontmatter opening ---`);
            return;
        }
        const fmStart = cursor + 1;
        let fmEnd = -1;
        for (let j = fmStart; j < sectionEnd; j++) {
            if ((lines[j] ?? "").trim() === "---") {
                fmEnd = j;
                break;
            }
        }
        if (fmEnd === -1) {
            errors.push(`${at}: unterminated frontmatter`);
            return;
        }

        const frontmatter = parseFrontmatter(lines.slice(fmStart, fmEnd));
        const name = frontmatter.get("name");
        const description = frontmatter.get("description");
        const model = frontmatter.get("model");
        if (name !== heading.name) {
            errors.push(
                `${at}: frontmatter name "${
                    name ?? ""
                }" does not match heading`,
            );
        }
        if (description === undefined || description === "") {
            errors.push(`${at}: missing frontmatter description`);
        }
        if (model === undefined || model === "") {
            errors.push(`${at}: missing frontmatter model`);
        }
        if (agents.has(heading.name)) {
            errors.push(`${at}: duplicate agent name`);
        }
        if (
            name !== heading.name ||
            description === undefined ||
            description === "" ||
            model === undefined ||
            model === "" ||
            agents.has(heading.name)
        ) {
            return;
        }

        const prompt = lines
            .slice(fmEnd + 1, sectionEnd)
            .join("\n")
            .trim();
        if (prompt === "") {
            errors.push(`${at}: empty prompt body`);
            return;
        }
        agents.set(heading.name, {name, description, model, prompt});
    });

    if (errors.length > 0) {
        throw new AgentExtractError(errors);
    }
    if (agents.size === 0) {
        throw new AgentExtractError(["no `## agent:` sections found"]);
    }
    return agents;
};
