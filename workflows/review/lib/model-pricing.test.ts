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
 *    request reaches the model (#266). `claude-opus-5-5` is in no released
 *    curated table (firewall v0.27.44 stops at `claude-opus-5`), so the
 *    `default-ai-credits-pricing` fallback stays the backstop for any
 *    toolchain that drops the overlay.
 *
 * DELETE the fallback test (only it) together with the fallback block when
 * the toolchain moves; the coverage test is permanent.
 *
 * The CLI-floor gate at the bottom is the same class of constraint with a
 * harsher failure: a pin the installed Claude Code CLI is too old for 400s
 * before any work happens, on the orchestrator (gh-aw's engine install) and
 * on every scripted sub-agent (the agent SDK's bundled CLI) independently.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, it, expect} from "vitest";

import {ANTHROPIC_LIST_RATES} from "./pricing";

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

/** The frontmatter's `engine:` block, up to the next top-level key. */
const engineBlock =
    frontmatter.match(/^engine:\n((?:(?: .*)?\n)*)/m)?.[1] ?? "";
const enginePin = engineBlock.match(/^ {2}model:\s*(\S+)\s*$/m)?.[1];
const engineVersion = engineBlock.match(
    /^ {2}version:\s*"?([\d.]+)"?\s*$/m,
)?.[1];

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

    it("keeps the credit-guard fallback while claude-opus-5-5 is pinned", () => {
        // No released firewall curated table prices claude-opus-5-5; without
        // `default-ai-credits-pricing` every dispatch 400s on a toolchain
        // that drops the overlay. Delete this test with the fallback block
        // once a gh-aw release defaults to a firewall that prices it.
        if (pins.includes("claude-opus-5-5")) {
            expect(frontmatter).toContain("default-ai-credits-pricing:");
        }
    });

    it("sets the credit-guard fallback at the engine pin's list rate", () => {
        // The fallback is $/1M at LIST (see its comment in review.md), and it
        // must follow the engine pin: a stale value meters every un-priced
        // dispatch at the previous model's price.
        const fallback = frontmatter.match(
            /^ {2}default-ai-credits-pricing:\n {4}input: ([\d.]+)\n {4}output: ([\d.]+)$/m,
        );
        const list = ANTHROPIC_LIST_RATES.get(enginePin ?? "");
        expect(fallback, "default-ai-credits-pricing block").not.toBeNull();
        expect(list, `${enginePin} has no list rate`).toBeDefined();
        expect(Number(fallback?.[1])).toBeCloseTo((list?.input ?? 0) * 1e6, 9);
        expect(Number(fallback?.[2])).toBeCloseTo((list?.output ?? 0) * 1e6, 9);
    });
});

/**
 * The oldest Claude Code CLI the API accepts for a pin (`400 ... does not
 * support this model; version <floor> or newer is required`). A pin with no
 * entry has no known floor. REMOVE the `engine.version` requirement below,
 * not the floor, once a gh-aw release installs a CLI at or above it: the pin
 * in review.md must go then, or it freezes the CLI.
 */
const CLI_FLOORS: Readonly<Record<string, string>> = {
    "claude-opus-5-5": "2.1.280",
};

const compareVersions = (a: string, b: string): number => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
};

/** The highest CLI floor any model in review.md needs, or undefined. */
const floor = pins
    .map((pin) => CLI_FLOORS[pin])
    .filter((version): version is string => version !== undefined)
    .sort(compareVersions)
    .at(-1);

describe("Claude Code CLI floor for the pinned models", () => {
    it("pins the orchestrator's CLI (engine.version) at or above the floor", () => {
        if (floor === undefined) {
            return;
        }
        expect(engineVersion, "engine.version in review.md").toBeDefined();
        expect(
            compareVersions(engineVersion ?? "0", floor),
        ).toBeGreaterThanOrEqual(0);
    });

    it("installs an agent SDK whose bundled CLI meets the floor (scripted dispatch)", () => {
        if (floor === undefined) {
            return;
        }
        const reviewDir = join(__dirname, "..");
        const pinned = (
            JSON.parse(
                readFileSync(join(reviewDir, "package.json"), "utf8"),
            ) as {dependencies: Record<string, string>}
        ).dependencies["@anthropic-ai/claude-agent-sdk"];
        // Production installs with `npm ci` from this lockfile.
        const locked = (
            JSON.parse(
                readFileSync(join(reviewDir, "package-lock.json"), "utf8"),
            ) as {packages: Record<string, {version?: string}>}
        ).packages["node_modules/@anthropic-ai/claude-agent-sdk"]?.version;
        expect(locked).toBe(pinned);
        // The SDK publishes the CLI version it bundles as `claudeCodeVersion`.
        const installed = JSON.parse(
            readFileSync(
                join(
                    reviewDir,
                    "node_modules",
                    "@anthropic-ai",
                    "claude-agent-sdk",
                    "package.json",
                ),
                "utf8",
            ),
        ) as {version: string; claudeCodeVersion: string};
        expect(installed.version, "installed SDK is stale; reinstall").toBe(
            pinned,
        );
        expect(
            compareVersions(installed.claudeCodeVersion, floor),
        ).toBeGreaterThanOrEqual(0);
    });
});
