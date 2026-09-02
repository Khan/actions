import {describe, it, expect} from "vitest";

import {renderCollapsedFooter} from "./attribution";
import {FINDING_SCHEMA_VERSION} from "./finding-schema";
import {
    FOOTER_OUT,
    hasCanaryFooter,
    renderVersionFooter,
    runVersionFooterCli,
    type VersionFooterFs,
} from "./version-footer";

/**
 * The version/config footer: the sanitizer-surviving replacement for
 * the hidden `pr-reviewer:version` HTML marker, which gh-aw's ingest
 * sanitizer stripped from every posted body; wrapped in the shared
 * collapsed `<details>` block (attribution.ts). Rendering is pure and every
 * unstateable segment is omitted, never guessed.
 */

const wrapped = (content: string): string => renderCollapsedFooter(content);

const makeFakeFs = (
    files: Record<string, string> = {},
): VersionFooterFs & {files: Record<string, string>} => {
    const state = {...files};
    return {
        files: state,
        readFileSync: (p: string) => {
            if (!(p in state)) {
                throw new Error(`ENOENT: ${p}`);
            }
            return state[p];
        },
        writeFileSync: (p: string, data: string) => {
            state[p] = data;
        },
        existsSync: (p: string) => p in state,
    };
};

const REVIEW = "/tmp/gh-aw/review";
const LIB = "/lib";

describe("renderVersionFooter", () => {
    it("renders every segment in order inside one collapsed <sub> line", () => {
        expect(
            renderVersionFooter({
                version: "1.13.0",
                schemaVersion: 2,
                depth: "scoped",
                reReviewMode: "scoped",
                blockingOnly: true,
                blockingMedium: false,
                enabledReviewers: ["holistic", "completeness"],
                nonBlockingInlineBudget: 5,
            }),
        ).toBe(
            wrapped(
                "review-v1.13.0 | schema 2 | depth scoped | re-review scoped blocking-only | enable holistic,completeness | non-blocking-budget 5",
            ),
        );
    });

    it("renders the blocking-medium modifier", () => {
        expect(
            renderVersionFooter({
                version: "1.13.0",
                schemaVersion: 2,
                depth: "scoped",
                reReviewMode: "scoped",
                blockingOnly: false,
                blockingMedium: true,
                enabledReviewers: [],
                nonBlockingInlineBudget: null,
            }),
        ).toBe(
            wrapped(
                "review-v1.13.0 | schema 2 | depth scoped | re-review scoped blocking-medium",
            ),
        );
    });

    it("omits the non-blocking budget at its default (the footer states configuration, not defaults)", () => {
        expect(
            renderVersionFooter({
                version: "1.13.0",
                schemaVersion: 2,
                depth: "full",
                reReviewMode: "full",
                blockingOnly: false,
                blockingMedium: false,
                enabledReviewers: [],
                nonBlockingInlineBudget: 3,
            }),
        ).toBe(
            wrapped("review-v1.13.0 | schema 2 | depth full | re-review full"),
        );
    });

    it("omits the blocking-only modifier when unset", () => {
        expect(
            renderVersionFooter({
                version: "1.13.0",
                schemaVersion: 2,
                depth: "full",
                reReviewMode: "full",
                blockingOnly: false,
                blockingMedium: false,
                enabledReviewers: [],
                nonBlockingInlineBudget: null,
            }),
        ).toBe(
            wrapped("review-v1.13.0 | schema 2 | depth full | re-review full"),
        );
    });

    it("degrades to schema-only when nothing else is stateable", () => {
        expect(
            renderVersionFooter({
                version: null,
                schemaVersion: 2,
                depth: null,
                reReviewMode: null,
                blockingOnly: true,
                blockingMedium: false,
                enabledReviewers: [],
                nonBlockingInlineBudget: null,
            }),
        ).toBe(wrapped("schema 2"));
    });

    it("never emits an HTML comment (the sanitizer would delete it)", () => {
        const footer = renderVersionFooter({
            version: "1.13.0",
            schemaVersion: 2,
            depth: "full",
            reReviewMode: "scoped",
            blockingOnly: true,
            enabledReviewers: ["holistic"],
        });
        expect(footer).not.toContain("<!--");
        expect(footer.startsWith("<details>")).toBe(true);
        expect(footer.endsWith("</details>")).toBe(true);
    });
});

describe("runVersionFooterCli", () => {
    const fullStaging = () => ({
        [`${LIB}/../package.json`]: JSON.stringify({version: "1.13.0"}),
        [`${REVIEW}/dispatch-result.json`]: JSON.stringify({depth: "scoped"}),
        [`${REVIEW}/rereview-plan.json`]: JSON.stringify({depth: "full"}),
        [`${REVIEW}/routing.json`]: JSON.stringify({
            reReviewMode: "scoped",
            reReviewBlockingOnly: true,
            enabledReviewers: ["holistic", "documentation"],
        }),
    });

    it("stamps the canary sha after the version segment (REVIEW_CANARY_SHA)", () => {
        expect(
            renderVersionFooter({
                version: "1.13.0",
                schemaVersion: 2,
                depth: "full",
                reReviewMode: null,
                blockingOnly: false,
                blockingMedium: false,
                enabledReviewers: [],
                nonBlockingInlineBudget: null,
                canarySha: "0123456789abcdef0123456789abcdef01234567",
            }),
        ).toBe(
            wrapped(
                "review-v1.13.0 | canary 0123456789ab | schema 2 | depth full",
            ),
        );
        const fs = makeFakeFs(fullStaging());
        expect(
            runVersionFooterCli(
                fs,
                LIB,
                {},
                {REVIEW_CANARY_SHA: "abc123def456789"},
            ),
        ).toContain("canary abc123def456");
        // Unset (every production run): no segment.
        expect(runVersionFooterCli(fs, LIB, {}, {})).not.toContain("canary");
    });

    it("reads REVIEW_CANARY_SHA from process.env by default (the production wiring)", () => {
        const fs = makeFakeFs(fullStaging());
        const prior = process.env.REVIEW_CANARY_SHA;
        process.env.REVIEW_CANARY_SHA = "fedcba9876543210";
        try {
            expect(runVersionFooterCli(fs, LIB)).toContain(
                "canary fedcba987654",
            );
        } finally {
            if (prior === undefined) {
                delete process.env.REVIEW_CANARY_SHA;
            } else {
                process.env.REVIEW_CANARY_SHA = prior;
            }
        }
    });

    it("hasCanaryFooter matches the rendered footer and not prose quoting it", () => {
        const canaryFooter = renderVersionFooter({
            version: "1.21.0",
            schemaVersion: 2,
            depth: "full",
            reReviewMode: null,
            blockingOnly: false,
            blockingMedium: false,
            enabledReviewers: [],
            nonBlockingInlineBudget: null,
            canarySha: "0123456789abcdef",
        });
        expect(hasCanaryFooter(`review body\n${canaryFooter}`)).toBe(true);
        // A production footer (no canary segment).
        const productionFooter = renderVersionFooter({
            version: "1.21.0",
            schemaVersion: 2,
            depth: "full",
            reReviewMode: null,
            blockingOnly: false,
            blockingMedium: false,
            enabledReviewers: [],
            nonBlockingInlineBudget: null,
        });
        expect(hasCanaryFooter(`review body\n${productionFooter}`)).toBe(false);
        // Prose QUOTING the segment outside a <sub> line is not a canary
        // review (the misfiling direction would drop a production review
        // from the reviewer's own history).
        expect(
            hasCanaryFooter(
                `The footer says canary 0123456789ab now.\n${productionFooter}`,
            ),
        ).toBe(false);
    });

    it("composes from the staged files and stages the footer file", () => {
        const fs = makeFakeFs(fullStaging());
        const footer = runVersionFooterCli(fs, LIB);
        expect(footer).toBe(
            wrapped(
                `review-v1.13.0 | schema ${FINDING_SCHEMA_VERSION} | depth scoped | re-review scoped blocking-only | enable holistic,documentation`,
            ),
        );
        expect(fs.files[FOOTER_OUT]).toBe(footer);
    });

    it("prefers the executed depth over the planned depth", () => {
        const fs = makeFakeFs(fullStaging());
        expect(runVersionFooterCli(fs, LIB)).toContain("depth scoped");
    });

    it("carries a non-default routing.json budget into the footer", () => {
        const files = fullStaging();
        files[`${REVIEW}/routing.json`] = JSON.stringify({
            reReviewMode: "scoped",
            reReviewBlockingOnly: true,
            enabledReviewers: ["holistic", "documentation"],
            nonBlockingInlineBudget: 5,
        });
        expect(runVersionFooterCli(makeFakeFs(files), LIB)).toContain(
            "| non-blocking-budget 5",
        );
    });

    it("omits the depth segment when dispatch has not run", () => {
        // No fallback to the planned depth: a plan is a guess about what
        // executed, and every unstateable segment drops rather than guesses.
        const files = fullStaging();
        delete (files as Record<string, string>)[
            `${REVIEW}/dispatch-result.json`
        ];
        const fs = makeFakeFs(files);
        expect(runVersionFooterCli(fs, LIB)).not.toContain("depth");
    });

    it("prefers the submission CLI's depth override over its own read", () => {
        // The override carries the same read that keys the depth Note and
        // blocking-only gating, so footer and Note cannot contradict.
        const fs = makeFakeFs(fullStaging());
        expect(runVersionFooterCli(fs, LIB, {depth: "scoped"})).toContain(
            "depth scoped",
        );
        expect(runVersionFooterCli(fs, LIB, {depth: null})).not.toContain(
            "depth",
        );
    });

    it("omits segments for missing or malformed staging", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/routing.json`]: "not json",
        });
        expect(runVersionFooterCli(fs, LIB)).toBe(
            wrapped(`schema ${FINDING_SCHEMA_VERSION}`),
        );
    });

    it("drops non-string entries from the enable list", () => {
        const files = fullStaging();
        files[`${REVIEW}/routing.json`] = JSON.stringify({
            enabledReviewers: ["holistic", 3, null, "conventions"],
        });
        const fs = makeFakeFs(files);
        expect(runVersionFooterCli(fs, LIB)).toContain(
            "enable holistic,conventions",
        );
    });
});
