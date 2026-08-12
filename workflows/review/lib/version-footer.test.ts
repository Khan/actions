import {describe, it, expect} from "vitest";

import {FINDING_SCHEMA_VERSION} from "./finding-schema";
import {
    FOOTER_OUT,
    renderVersionFooter,
    runVersionFooterCli,
    type VersionFooterFs,
} from "./version-footer";

/**
 * The visible attribution footer: the sanitizer-surviving replacement for
 * the hidden `pr-reviewer:version` HTML marker, which gh-aw's ingest
 * sanitizer stripped from every posted body. Rendering is pure and every
 * unstateable segment is omitted, never guessed.
 */

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
    it("renders every segment in order inside one <sub> line", () => {
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
            "<sub>review-v1.13.0 | schema 2 | depth scoped | re-review scoped blocking-only | enable holistic,completeness</sub>",
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
            "<sub>review-v1.13.0 | schema 2 | depth full | re-review full</sub>",
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
        ).toBe("<sub>schema 2</sub>");
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
        expect(footer.startsWith("<sub>")).toBe(true);
        expect(footer.endsWith("</sub>")).toBe(true);
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
            `<sub>review-v1.13.0 | schema ${FINDING_SCHEMA_VERSION} | depth scoped | re-review scoped blocking-only | enable holistic,documentation</sub>`,
        );
        expect(fs.files[FOOTER_OUT]).toBe(footer);
    });

    it("prefers the executed depth over the planned depth", () => {
        const fs = makeFakeFs(fullStaging());
        expect(runVersionFooterCli(fs, LIB)).toContain("depth scoped");
    });

    it("falls back to the planned depth when dispatch has not run", () => {
        const files = fullStaging();
        delete (files as Record<string, string>)[
            `${REVIEW}/dispatch-result.json`
        ];
        const fs = makeFakeFs(files);
        expect(runVersionFooterCli(fs, LIB)).toContain("depth full");
    });

    it("omits segments for missing or malformed staging", () => {
        const fs = makeFakeFs({
            [`${REVIEW}/routing.json`]: "not json",
        });
        expect(runVersionFooterCli(fs, LIB)).toBe(
            `<sub>schema ${FINDING_SCHEMA_VERSION}</sub>`,
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
