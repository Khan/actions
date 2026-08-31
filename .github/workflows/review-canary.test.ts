/**
 * CI backstop for the canary reviewer (review-canary.md), the opt-in
 * workflow that runs the reviewer from a labeled PR's own head instead of
 * the pinned release (the dogfooding flow: a PR that changes the reviewer
 * can post a review with the changed code, IN ADDITION to the pinned
 * reviewer's own run).
 *
 * The canary is a hand-derived variant of the installed review.md, so the
 * two drift unless CI holds them together:
 *
 *   - the BODY must stay byte-identical to review.md's after the canary
 *     preamble (the preamble carries the canary's standing overrides; the
 *     rest is the shared prompt, and a review.md prompt edit that forgets
 *     the canary would silently fork the reviewer's instructions);
 *   - the `source:` provenance line must match review.md's, so the manual
 *     release-bump flow (which edits review.md's pins) is forced to carry
 *     the canary along;
 *   - the deltas that make it a canary (head-sha lib checkout, canary env,
 *     the label gate, and the ABSENT capabilities: thread resolution,
 *     reviewer requests, cache memory) must not regress, because each one
 *     protects the production reviewer's state from unreleased code;
 *   - review-canary.lock.yml must have been recompiled from this
 *     review-canary.md (spot-checked on every delta above; nothing in CI
 *     runs `gh aw compile`, same caveat as review-pins.test.ts).
 */
import * as fs from "fs";
import {describe, expect, it} from "vitest";

const canaryMd = fs.readFileSync(
    new URL("./review-canary.md", import.meta.url),
    "utf-8",
);
const canaryLock = fs.readFileSync(
    new URL("./review-canary.lock.yml", import.meta.url),
    "utf-8",
);
const reviewMd = fs.readFileSync(
    new URL("./review.md", import.meta.url),
    "utf-8",
);

/** The markdown body after the frontmatter block. */
const bodyOf = (markdown: string): string => {
    const close = markdown.indexOf("\n---\n", 3);
    expect(close).toBeGreaterThan(0);
    return markdown.slice(close + "\n---\n".length);
};

/** The frontmatter's non-comment lines (the prompt body and the YAML
 * comments legitimately MENTION the absent capabilities; only a real key
 * regresses the canary). */
const frontmatterCode = (markdown: string): string => {
    const close = markdown.indexOf("\n---\n", 3);
    return markdown
        .slice(0, close)
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
};

/** Everything after (and excluding) the first occurrence of `needle`. */
const after = (text: string, needle: string): string => {
    const at = text.indexOf(needle);
    expect(at, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(
        -1,
    );
    return text.slice(at + needle.length);
};

const PREAMBLE_END = "<!-- END CANARY PREAMBLE -->\n";

describe("review-canary.md vs the installed review.md", () => {
    it("shares review.md's prompt byte-for-byte after the canary preamble", () => {
        expect(after(bodyOf(canaryMd), PREAMBLE_END)).toBe(
            after(bodyOf(reviewMd), "# PR Reviewer\n"),
        );
    });

    it("records the same source: provenance as review.md", () => {
        const sourceLine = (markdown: string): string | undefined =>
            markdown.match(/^source:.*$/m)?.[0];
        expect(sourceLine(canaryMd)).toBeDefined();
        expect(sourceLine(canaryMd)).toBe(sourceLine(reviewMd));
    });
});

describe("review-canary.md deltas", () => {
    it("checks out the lib at the PR head, never a release pin", () => {
        expect(canaryMd).toContain(
            "ref: ${{ github.event.pull_request.head.sha }}",
        );
        // The only release literal is the source: provenance line.
        const literals = canaryMd.match(/^\s*ref:\s*review-v\S+$/gm) ?? [];
        expect(literals).toEqual([]);
    });

    it("stages with REVIEW_CANARY=1 and stamps REVIEW_CANARY_SHA", () => {
        expect(canaryMd).toContain('REVIEW_CANARY: "1"');
        expect(canaryMd).toContain(
            "REVIEW_CANARY_SHA: ${{ github.event.pull_request.head.sha }}",
        );
        // The agent-side CLIs (submission demotion, stamp suppression, the
        // gate's canary rule) read the WORKFLOW-level env, not the staging
        // step's copy; both must carry the flag.
        const workflowEnv = frontmatterCode(canaryMd).match(
            /^env:\n(?:^ {2}\S.*\n?)+/m,
        )?.[0];
        expect(workflowEnv).toBeDefined();
        expect(workflowEnv).toContain('REVIEW_CANARY: "1"');
    });

    it("submits COMMENT only (a canary must never move the bot's review state)", () => {
        expect(frontmatterCode(canaryMd)).toContain(
            "allowed-events: [COMMENT]",
        );
    });

    it("is gated on the review-canary label with the fork guard intact", () => {
        expect(canaryMd).toContain(
            "contains(github.event.pull_request.labels.*.name, 'review-canary')",
        );
        expect(canaryMd).toContain(
            "github.event.pull_request.head.repo.full_name == github.repository",
        );
        expect(canaryMd).toContain(
            "github.event.action != 'labeled' || github.event.label.name == 'review-canary'",
        );
    });

    it("carries none of the capabilities that touch the production reviewer's state", () => {
        // Thread resolution would close the pinned reviewer's findings;
        // add-reviewer (via the imports: config) would page owning teams;
        // cache memory would let one workflow's record leak into the other's
        // scope computation.
        const code = frontmatterCode(canaryMd);
        expect(code).not.toContain("resolve-pull-request-review-thread:");
        expect(code).not.toMatch(/^imports:/m);
        expect(code).not.toContain("add-reviewer:");
        expect(code).not.toContain("cache-memory:");
    });
});

describe("compiled review-canary.lock.yml", () => {
    it("was recompiled from this review-canary.md (every delta present)", () => {
        expect(canaryLock).toContain('name: "PR Reviewer Canary"');
        expect(canaryLock).toContain(
            "ref: ${{ github.event.pull_request.head.sha }}",
        );
        expect(canaryLock).toContain('REVIEW_CANARY: "1"');
        expect(canaryLock).toContain(
            "REVIEW_CANARY_SHA: ${{ github.event.pull_request.head.sha }}",
        );
        expect(canaryLock).toContain("- labeled");
        expect(canaryLock).toContain("- synchronize");
        expect(canaryLock).toContain(
            "contains(github.event.pull_request.labels.*.name, 'review-canary')",
        );
        expect(canaryLock).toContain('"allowed_events":["COMMENT"]');
        expect(canaryLock).toContain('REVIEW_CANARY: "1"');
        expect(canaryLock).not.toContain("resolve_pull_request_review_thread");
        expect(canaryLock).not.toContain("add_reviewer");
        expect(canaryLock).not.toContain("cache-memory");
    });
});
