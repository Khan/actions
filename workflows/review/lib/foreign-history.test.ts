import {describe, it, expect, vi} from "vitest";

import {
    currentIdentity,
    foreignHistoryReason,
    installFromWorkflowRef,
    parseFooterIdentity,
} from "./foreign-history.ts";
import {
    renderVersionFooter,
    renderVersionFooterLine,
} from "./version-footer.ts";

const footer = (version: string, install: string | null): string =>
    renderVersionFooterLine({
        version,
        install,
        schemaVersion: 2,
        depth: "full",
        reReviewMode: "fast",
        blockingOnly: false,
        blockingMedium: false,
        enabledReviewers: [],
        nonBlockingInlineBudget: null,
    });

describe("installFromWorkflowRef", () => {
    it("names the workflow file", () => {
        expect(
            installFromWorkflowRef(
                "Khan/frontend/.github/workflows/review-beta.lock.yml@refs/pull/1/merge",
            ),
        ).toBe("review-beta");
        expect(
            installFromWorkflowRef(
                "o/r/.github/workflows/review.yml@refs/heads/main",
            ),
        ).toBe("review");
    });

    it("is null for a missing or unrecognized ref", () => {
        expect(installFromWorkflowRef(undefined)).toBeNull();
        expect(installFromWorkflowRef("not a ref")).toBeNull();
    });
});

describe("currentIdentity", () => {
    it("pairs the major version with the install", () => {
        expect(
            currentIdentity("2.3.1", "o/r/.github/workflows/review.lock.yml@x"),
        ).toEqual({major: 2, install: "review"});
    });

    it("is null when either half is unknown", () => {
        expect(
            currentIdentity(
                undefined,
                "o/r/.github/workflows/review.lock.yml@x",
            ),
        ).toBeNull();
        expect(currentIdentity("2.0.0", undefined)).toBeNull();
    });
});

describe("parseFooterIdentity", () => {
    it("reads the footer line in a review body and in the wrapped form", () => {
        expect(
            parseFooterIdentity(`body\n${footer("2.1.0", "review-beta")}`),
        ).toEqual({
            major: 2,
            install: "review-beta",
        });
        expect(
            parseFooterIdentity(
                renderVersionFooter({
                    version: "2.1.0",
                    install: "review",
                    schemaVersion: 2,
                    depth: null,
                    reReviewMode: null,
                    blockingOnly: false,
                    blockingMedium: false,
                    enabledReviewers: [],
                    nonBlockingInlineBudget: null,
                }),
            ),
        ).toEqual({major: 2, install: "review"});
    });

    it("is null for a footer without an install segment, and for no footer", () => {
        expect(parseFooterIdentity(footer("1.26.0", null))).toBeNull();
        expect(parseFooterIdentity("**Approved**")).toBeNull();
    });
});

describe("foreignHistoryReason", () => {
    const me = {major: 2, install: "review"};
    const at = (body: string, submittedAt: string) => ({body, submittedAt});

    it("is null with no prior reviews, and for the same install and major", () => {
        expect(foreignHistoryReason([], me)).toBeNull();
        expect(
            foreignHistoryReason([at(footer("2.4.0", "review"), "t1")], me),
        ).toBeNull();
    });

    it("judges only the newest review", () => {
        expect(
            foreignHistoryReason(
                [
                    at(footer("2.0.0", "review"), "2026-01-02"),
                    at("fork review", "2026-01-01"),
                ],
                me,
            ),
        ).toBeNull();
        expect(
            foreignHistoryReason(
                [
                    at(footer("2.0.0", "review"), "2026-01-01"),
                    at("fork review", "2026-01-02"),
                ],
                me,
            ),
        ).toContain("no readable version footer");
    });

    it("names an install or major mismatch", () => {
        expect(
            foreignHistoryReason([at(footer("2.0.0", "review-beta"), "t")], me),
        ).toContain("install review-beta");
        expect(
            foreignHistoryReason([at(footer("1.26.0", "review"), "t")], me),
        ).toContain("major version 1");
    });

    it("fails closed when this run's identity is unknown", () => {
        expect(
            foreignHistoryReason([at(footer("2.0.0", "review"), "t")], null),
        ).toContain("unknown");
    });
});

describe("thread identity", () => {
    it("round-trips through the attribution footer and requires both halves to match", async () => {
        const {renderAttributionFooter} = await import("./attribution.ts");
        const {parseThreadIdentity, sameIdentity} = await import(
            "./foreign-history.ts"
        );
        const me = {major: 2, install: "review-beta"};
        const body = `**nit:** x\n${renderAttributionFooter(
            "holistic",
            [],
            undefined,
            me,
        )}`;
        expect(body).toContain("found by holistic | install review-beta@v2");
        expect(parseThreadIdentity(body)).toEqual(me);
        expect(sameIdentity(parseThreadIdentity(body), me)).toBe(true);
        expect(
            sameIdentity(parseThreadIdentity(body), {
                major: 3,
                install: "review-beta",
            }),
        ).toBe(false);
        expect(
            parseThreadIdentity(
                renderAttributionFooter("holistic", [], undefined, null),
            ),
        ).toBeNull();
        expect(sameIdentity(null, me)).toBe(false);
    });
});

describe("runIdentity", () => {
    it("reads this checkout's release major and the runner's workflow ref", async () => {
        vi.resetModules();
        process.env.GITHUB_WORKFLOW_REF =
            "o/r/.github/workflows/review-beta.lock.yml@refs/pull/1/merge";
        try {
            const {runIdentity} = await import("./foreign-history.ts");
            const {readFileSync} = await import("node:fs");
            const major = Number(
                JSON.parse(
                    readFileSync(
                        new URL("../package.json", import.meta.url),
                        "utf8",
                    ),
                ).version.split(".")[0],
            );
            expect(runIdentity()).toEqual({major, install: "review-beta"});
        } finally {
            delete process.env.GITHUB_WORKFLOW_REF;
            vi.resetModules();
        }
    });
});
