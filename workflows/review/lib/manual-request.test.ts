import {describe, it, expect} from "vitest";

import {
    commentAuthorFromEvent,
    commentFromEvent,
    isManualReviewRequest,
    requestedDepthFromComment,
} from "./manual-request";

describe("isManualReviewRequest", () => {
    it("only an issue_comment trigger can be manual", () => {
        expect(
            isManualReviewRequest("pull_request", {
                login: "a-human",
                type: "User",
            }),
        ).toBe(false);
        expect(isManualReviewRequest(undefined, undefined)).toBe(false);
    });

    it("a human author is manual; automation is not", () => {
        expect(
            isManualReviewRequest("issue_comment", {
                login: "a-human",
                type: "User",
            }),
        ).toBe(true);
        // The GitHub App shape (github-actions[bot] and friends).
        expect(
            isManualReviewRequest("issue_comment", {
                login: "github-actions[bot]",
                type: "Bot",
            }),
        ).toBe(false);
        // The classic-PAT machine account: type User, named by login (the
        // webapp shim posts /review with it on every push).
        expect(
            isManualReviewRequest("issue_comment", {
                login: "khan-actions-bot",
                type: "User",
            }),
        ).toBe(false);
    });

    it("an unknown author on a comment trigger fails toward manual (full)", () => {
        expect(isManualReviewRequest("issue_comment", undefined)).toBe(true);
        expect(isManualReviewRequest("issue_comment", {})).toBe(true);
    });

    it("matches automation logins case-folded", () => {
        expect(
            isManualReviewRequest("issue_comment", {
                login: "Khan-Actions-Bot",
                type: "User",
            }),
        ).toBe(false);
    });

    it("REVIEW_AUTOMATION_LOGINS overrides the default list", () => {
        // Deployment config, same as REVIEW_BOT_LOGIN: which account fronts
        // a consumer's automation is a property of that installation.
        const previous = process.env.REVIEW_AUTOMATION_LOGINS;
        process.env.REVIEW_AUTOMATION_LOGINS = "Other-Shim-Bot, second-bot";
        try {
            expect(
                isManualReviewRequest("issue_comment", {
                    login: "other-shim-bot",
                    type: "User",
                }),
            ).toBe(false);
            expect(
                isManualReviewRequest("issue_comment", {
                    login: "second-bot",
                    type: "User",
                }),
            ).toBe(false);
            // The default is REPLACED, not extended.
            expect(
                isManualReviewRequest("issue_comment", {
                    login: "khan-actions-bot",
                    type: "User",
                }),
            ).toBe(true);
            // An empty or whitespace-only value restores the default
            // instead of emptying the carve-out (the REVIEW_BOT_LOGIN
            // precedent: `?.trim() ||`, never `??`).
            process.env.REVIEW_AUTOMATION_LOGINS = "  ";
            expect(
                isManualReviewRequest("issue_comment", {
                    login: "khan-actions-bot",
                    type: "User",
                }),
            ).toBe(false);
        } finally {
            if (previous === undefined) {
                delete process.env.REVIEW_AUTOMATION_LOGINS;
            } else {
                process.env.REVIEW_AUTOMATION_LOGINS = previous;
            }
        }
    });
});

describe("commentAuthorFromEvent", () => {
    const fsOf = (files: Record<string, string>) => ({
        readFileSync: (p: string) => {
            const content = files[p];
            if (content === undefined) {
                throw new Error(`ENOENT: ${p}`);
            }
            return content;
        },
        existsSync: (p: string) => p in files,
    });

    it("reads the comment author's login and type", () => {
        const fs = fsOf({
            "/e.json": JSON.stringify({
                comment: {user: {login: "someone", type: "User"}},
            }),
        });
        expect(commentAuthorFromEvent(fs, "/e.json")).toEqual({
            login: "someone",
            type: "User",
        });
    });

    it("returns undefined for a missing path, bad JSON, or no comment", () => {
        expect(commentAuthorFromEvent(fsOf({}), undefined)).toBeUndefined();
        expect(commentAuthorFromEvent(fsOf({}), "/e.json")).toBeUndefined();
        expect(
            commentAuthorFromEvent(fsOf({"/e.json": "not json"}), "/e.json"),
        ).toBeUndefined();
        expect(
            commentAuthorFromEvent(
                fsOf({"/e.json": JSON.stringify({action: "created"})}),
                "/e.json",
            ),
        ).toBeUndefined();
    });

    it("drops non-string login/type fields instead of trusting them", () => {
        const fs = fsOf({
            "/e.json": JSON.stringify({
                comment: {user: {login: 42, type: "User"}},
            }),
        });
        expect(commentAuthorFromEvent(fs, "/e.json")).toEqual({type: "User"});
    });
});

describe("commentFromEvent", () => {
    const fsOf = (files: Record<string, string>) => ({
        readFileSync: (p: string) => {
            const content = files[p];
            if (content === undefined) {
                throw new Error(`ENOENT: ${p}`);
            }
            return content;
        },
        existsSync: (p: string) => p in files,
    });

    it("reads the body alongside the author", () => {
        const fs = fsOf({
            "/e.json": JSON.stringify({
                comment: {
                    body: "/review scoped\r\n",
                    user: {login: "someone", type: "User"},
                },
            }),
        });
        expect(commentFromEvent(fs, "/e.json")).toEqual({
            body: "/review scoped\r\n",
            author: {login: "someone", type: "User"},
        });
    });

    it("an event without a comment yields neither field", () => {
        const fs = fsOf({"/e.json": JSON.stringify({action: "synchronize"})});
        expect(commentFromEvent(fs, "/e.json")).toEqual({});
    });

    it("drops a non-string body", () => {
        const fs = fsOf({
            "/e.json": JSON.stringify({
                comment: {body: 7, user: {login: "someone", type: "User"}},
            }),
        });
        expect(commentFromEvent(fs, "/e.json")).toEqual({
            author: {login: "someone", type: "User"},
        });
    });
});

describe("requestedDepthFromComment", () => {
    it("a bare /review names no depth", () => {
        expect(requestedDepthFromComment("/review")).toBeNull();
        expect(requestedDepthFromComment("/review\r\n")).toBeNull();
        expect(requestedDepthFromComment("/review  \n")).toBeNull();
        expect(requestedDepthFromComment(undefined)).toBeNull();
    });

    it("reads the mode after /review, case-folded", () => {
        expect(requestedDepthFromComment("/review scoped")).toBe("scoped");
        expect(requestedDepthFromComment("/review Scoped\r\n")).toBe("scoped");
        expect(requestedDepthFromComment("/review flip-gated")).toBe(
            "flip-gated",
        );
        expect(requestedDepthFromComment("/review fast")).toBe("fast");
        expect(requestedDepthFromComment("/review full")).toBe("full");
    });

    it("delta, diff, and diff-only are synonyms for scoped", () => {
        expect(requestedDepthFromComment("/review delta")).toBe("scoped");
        expect(requestedDepthFromComment("/review diff")).toBe("scoped");
        expect(requestedDepthFromComment("/review diff-only")).toBe("scoped");
        expect(requestedDepthFromComment("/review Diff-Only")).toBe("scoped");
    });

    it("only the first token counts; trailing prose is ignored", () => {
        expect(
            requestedDepthFromComment(
                "/review scoped please, just the new bits",
            ),
        ).toBe("scoped");
        expect(requestedDepthFromComment("/review\nscoped")).toBeNull();
    });

    it("a token that names no mode is null (the planner then defaults to full)", () => {
        expect(requestedDepthFromComment("/review scope")).toBeNull();
        expect(requestedDepthFromComment("/review now")).toBeNull();
        expect(requestedDepthFromComment("/reviewscoped")).toBeNull();
        expect(requestedDepthFromComment("please /review scoped")).toBeNull();
    });
});
