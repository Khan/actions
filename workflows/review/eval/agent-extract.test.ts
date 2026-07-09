import {readFileSync} from "node:fs";

import {describe, it, expect} from "vitest";

import {AgentExtractError, extractAgents} from "./agent-extract";
import {PRODUCTION_REVIEW_DIR} from "./live-stage";

/** Build a well-formed agent section. */
const section = (
    name: string,
    body = "Review the diff and return JSON.",
    frontmatter?: string,
): string =>
    [
        `## agent: \`${name}\``,
        "---",
        frontmatter ??
            [
                `name: ${name}`,
                `description: A ${name} test agent.`,
                "model: claude-opus-4-8",
                "# effort: high (launch default)",
            ].join("\n"),
        "---",
        body,
        "",
    ].join("\n");

describe("extractAgents: fixture markdown", () => {
    it("extracts sections in order with frontmatter fields and body", () => {
        const md = [
            "# Workflow prose the extractor must skip",
            "",
            section("alpha", "Alpha prompt body.\n\nWith two paragraphs."),
            section("beta"),
        ].join("\n");
        const agents = extractAgents(md);
        expect([...agents.keys()]).toEqual(["alpha", "beta"]);
        const alpha = agents.get("alpha");
        expect(alpha?.model).toBe("claude-opus-4-8");
        expect(alpha?.description).toBe("A alpha test agent.");
        expect(alpha?.prompt).toBe(
            "Alpha prompt body.\n\nWith two paragraphs.",
        );
    });

    it("ignores comment lines in frontmatter (the effort annotations)", () => {
        const agents = extractAgents(section("gamma"));
        expect(agents.get("gamma")?.model).toBe("claude-opus-4-8");
    });

    it("throws listing every problem at once", () => {
        const md = [
            section("good"),
            // name mismatch
            section(
                "bad-name",
                "Body.",
                ["name: other", "description: d", "model: m"].join("\n"),
            ),
            // missing model
            section(
                "no-model",
                "Body.",
                ["name: no-model", "description: d"].join("\n"),
            ),
        ].join("\n");
        let message = "";
        try {
            extractAgents(md);
        } catch (error) {
            expect(error).toBeInstanceOf(AgentExtractError);
            message = (error as Error).message;
        }
        expect(message).toMatch(/bad-name.*does not match heading/);
        expect(message).toMatch(/no-model.*missing frontmatter model/);
    });

    it("throws on an unterminated frontmatter block", () => {
        const md = ["## agent: `broken`", "---", "name: broken", ""].join("\n");
        expect(() => extractAgents(md)).toThrow(/unterminated frontmatter/);
    });

    it("throws on duplicate agent names", () => {
        expect(() => extractAgents(section("dup") + section("dup"))).toThrow(
            /duplicate agent name/,
        );
    });

    it("throws when no agent sections exist", () => {
        expect(() => extractAgents("# just prose")).toThrow(
            /no `## agent:` sections/,
        );
    });
});

describe("extractAgents: the real review.md", () => {
    const markdown = readFileSync("workflows/review/review.md", "utf8");
    const agents = extractAgents(markdown);

    it("extracts every `## agent:` section in the file", () => {
        const headings = markdown
            .split("\n")
            .filter((line) => /^## agent: `[^`]+`\s*$/.test(line));
        expect(agents.size).toBe(headings.length);
        expect(agents.size).toBeGreaterThanOrEqual(21);
    });

    it("pins a model on every agent", () => {
        for (const agent of agents.values()) {
            expect(agent.model).toMatch(/^claude-/);
        }
    });

    it("the default-roster reviewers reference the production staging root", () => {
        // The staging-path rewrite (live-stage.ts) depends on prompts naming
        // PRODUCTION_REVIEW_DIR verbatim; if review.md renames the staging
        // root, this fails here rather than silently staging nothing.
        for (const name of [
            "correctness-reviewer",
            "skill-auditor",
            "claim-validator",
        ]) {
            expect(
                agents.get(name)?.prompt,
                `${name} missing ${PRODUCTION_REVIEW_DIR}`,
            ).toContain(PRODUCTION_REVIEW_DIR);
        }
    });
});
