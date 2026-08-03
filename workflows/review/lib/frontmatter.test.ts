import {describe, it, expect} from "vitest";

import {
    frontmatterBlock,
    hasKey,
    items,
    nested,
    nestedPath,
    scalar,
    yamlLines,
} from "./frontmatter.ts";

/**
 * The frontmatter reader's contract. Two behaviours here are load-bearing for
 * the consumer-config checker rather than incidental: a commented-out block must
 * read as absent (that is how a consumer disables `observability:`), and nesting
 * must be indent-scoped, so an `add-reviewer` under `safe-outputs` is only found
 * at that path and not by a substring hit anywhere in the file.
 */

const block = (content: string) => yamlLines(frontmatterBlock(content) ?? "");

const WORKFLOW = `---
description: >
  Reviews PR code changes.
imports:
  - .github/aw/review/config.md
permissions:
  contents: read
safe-outputs:
  create-pull-request-review-comment:
    max: 20
  add-comment:
    target: "triggering"
# observability is disabled here because this repo has no OTEL secrets.
# observability:
#   otlp:
#     exporters:
#       - url: \${{ secrets.GH_AW_OTEL_SENTRY_ENDPOINT }}
max-ai-credits: 2500
source: Khan/actions/workflows/review/review.md@review-v1.11.0
---

# Prompt body

safe-outputs: this line is prose, not frontmatter.
`;

describe("frontmatterBlock", () => {
    it("returns the lines between the leading and closing ---", () => {
        expect(frontmatterBlock("---\na: 1\n---\nbody\n")).toBe("a: 1");
    });

    it("is undefined without a leading --- or a closing one", () => {
        expect(frontmatterBlock("# just markdown\n")).toBeUndefined();
        expect(frontmatterBlock("---\na: 1\nno terminator\n")).toBeUndefined();
    });
});

describe("yamlLines", () => {
    it("reads keys, scalars, items and indentation, dropping comments", () => {
        expect(yamlLines("a: 1\n# note\n  - x\n\nb:\n")).toEqual([
            {indent: 0, key: "a", value: "1"},
            {indent: 2, item: "x"},
            {indent: 0, key: "b", value: ""},
        ]);
    });
});

describe("reading a gh-aw workflow's frontmatter", () => {
    const lines = block(WORKFLOW);

    it("reads top-level scalars", () => {
        expect(scalar(lines, "source")).toBe(
            "Khan/actions/workflows/review/review.md@review-v1.11.0",
        );
        expect(scalar(lines, "max-ai-credits")).toBe("2500");
    });

    it("reads a key with no inline value as undefined but present", () => {
        expect(scalar(lines, "safe-outputs")).toBeUndefined();
        expect(hasKey(lines, "safe-outputs")).toBe(true);
    });

    it("reads list items under a key", () => {
        expect(items(nested(lines, "imports") ?? [])).toEqual([
            ".github/aw/review/config.md",
        ]);
    });

    it("treats a commented-out block as absent", () => {
        expect(hasKey(lines, "observability")).toBe(false);
    });

    it("does not see frontmatter keys spelled in the markdown body", () => {
        // `safe-outputs:` also appears as prose below the closing ---; the
        // block boundary is what keeps it out.
        expect(nested(lines, "safe-outputs")?.length).toBe(4);
    });

    it("scopes nesting to the given path", () => {
        expect(
            nestedPath(lines, ["safe-outputs", "add-comment"]),
        ).not.toBeUndefined();
        expect(
            nestedPath(lines, ["safe-outputs", "add-reviewer"]),
        ).toBeUndefined();
        // `contents` is nested under permissions, not at the top level.
        expect(hasKey(lines, "contents")).toBe(false);
        expect(hasKey(nested(lines, "permissions") ?? [], "contents")).toBe(
            true,
        );
    });

    it("returns undefined for a missing hop rather than throwing", () => {
        expect(nestedPath(lines, ["nope", "deeper"])).toBeUndefined();
        expect(nested([], "anything")).toBeUndefined();
        expect(scalar([], "anything")).toBeUndefined();
        expect(hasKey([], "anything")).toBe(false);
    });
});

describe("items", () => {
    it("strips surrounding quotes and skips non-item lines", () => {
        expect(
            items(
                yamlLines(`- "kore"\n- 'github-actions'\nkey: value\n- bare`),
            ),
        ).toEqual(["kore", "github-actions", "bare"]);
    });
});
