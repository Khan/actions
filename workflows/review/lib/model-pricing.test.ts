/**
 * Mechanical pricing gates for the model pins in review.md (#294 review
 * feedback: the merge-ordering constraint "do not ship an un-priced pin"
 * rested entirely on human memory of a draft PR).
 *
 * Two hazards, both prose-only until this file:
 *
 *  - The `models.providers` overlay matches per model and an unlisted model
 *    silently bills at FULL list price (the overlay's own MAINTENANCE note);
 *    the overlay omitting `claude-sonnet-4-6` shipped exactly that way in an
 *    earlier draft of #314.
 *  - On the stable toolchain (gh-aw v0.83.x -> firewall v0.27.42) the
 *    `providers` block is dropped silently and the api-proxy's credit guard
 *    rejects a model its curated table does not price with a 400 before the
 *    request reaches the model (#266). `claude-opus-5` is not in that table,
 *    so the `default-ai-credits-pricing` fallback is load-bearing for every
 *    dispatch until a gh-aw release defaults the firewall to v0.27.43+.
 *
 * DELETE the fallback test (only it) together with the fallback block when
 * the toolchain moves; the coverage test is permanent.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

const reviewMd = readFileSync(join(__dirname, "..", "review.md"), "utf8");

/** The workflow frontmatter (between the first pair of --- fences). */
const frontmatter = reviewMd.split(/^---$/m)[1] ?? "";

/**
 * Every model pin in the file: the engine's indented `model:` line in the
 * frontmatter plus each sub-agent's `model:` line in its block frontmatter.
 */
const pins = [
    ...new Set(
        [...reviewMd.matchAll(/^\s*model:\s*(claude-[a-z0-9.-]+)\s*$/gm)].map(
            (match) => match[1],
        ),
    ),
];

/**
 * The models the `providers` overlay prices: bare `claude-*:` mapping keys in
 * the frontmatter (only the providers block declares them).
 */
const priced = new Set(
    [...frontmatter.matchAll(/^\s+(claude-[a-z0-9.-]+):\s*$/gm)].map(
        (match) => match[1],
    ),
);

describe("model pricing coverage (review.md frontmatter)", () => {
    it("finds the pins and the overlay (guards the extraction itself)", () => {
        // 22 agents plus the engine; a collapse to zero means the regexes
        // rotted, not that the roster emptied.
        expect(pins.length).toBeGreaterThanOrEqual(2);
        expect(priced.size).toBeGreaterThanOrEqual(2);
    });

    it("prices every pinned model in the providers overlay", () => {
        const unpriced = pins.filter((pin) => !priced.has(pin));
        // An unlisted model silently bills at full list price; add an entry
        // at 50% of its Anthropic list rate (see the MAINTENANCE note).
        expect(unpriced).toEqual([]);
    });

    it("keeps the stable-toolchain credit-guard fallback while claude-opus-5 is pinned", () => {
        // Firewall v0.27.42's curated table does not price claude-opus-5;
        // without `default-ai-credits-pricing` every dispatch 400s on the
        // stable toolchain. Delete this test with the fallback block once a
        // gh-aw release defaults the firewall to v0.27.43+.
        if (pins.includes("claude-opus-5")) {
            expect(frontmatter).toContain("default-ai-credits-pricing:");
        }
    });
});
