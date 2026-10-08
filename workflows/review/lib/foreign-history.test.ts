import {describe, it, expect} from "vitest";

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
