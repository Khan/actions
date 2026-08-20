import {describe, it, expect} from "vitest";

import {renderCollapsedFooter} from "./attribution";
import {FINDING_SCHEMA_VERSION} from "./finding-schema";
import {
    FOOTER_OUT,
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
                enabledReviewers: ["holistic", "completeness"],
            }),
        ).toBe(
            wrapped(
                "review-v1.13.0 | schema 2 | depth scoped | re-review scoped blocking-only | enable holistic,completeness",
            ),
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
                enabledReviewers: [],
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
                enabledReviewers: [],
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
