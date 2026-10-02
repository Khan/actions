import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {
    AI_ROUTER_ANTHROPIC_URL,
    messagesHeaders,
    messagesUrl,
    withRouterDefault,
} from "./anthropic-api";

describe("messagesUrl", () => {
    it("defaults to ai-router", () => {
        expect(messagesUrl({})).toBe(`${AI_ROUTER_ANTHROPIC_URL}/v1/messages`);
    });

    it("treats an empty ANTHROPIC_BASE_URL as unset", () => {
        expect(messagesUrl({ANTHROPIC_BASE_URL: ""})).toBe(
            `${AI_ROUTER_ANTHROPIC_URL}/v1/messages`,
        );
    });

    it("follows ANTHROPIC_BASE_URL, path and all", () => {
        expect(
            messagesUrl({
                ANTHROPIC_BASE_URL:
                    "http://localhost:8134/api/internal/_ai-router/anthropic/",
            }),
        ).toBe(
            "http://localhost:8134/api/internal/_ai-router/anthropic/v1/messages",
        );
        expect(
            messagesUrl({ANTHROPIC_BASE_URL: "https://api.anthropic.com"}),
        ).toBe("https://api.anthropic.com/v1/messages");
    });
});

describe("withRouterDefault", () => {
    it("keeps the rest of the env and an explicit base URL", () => {
        expect(
            withRouterDefault({
                PATH: "/bin",
                ANTHROPIC_BASE_URL: "http://proxy",
            }),
        ).toEqual({PATH: "/bin", ANTHROPIC_BASE_URL: "http://proxy"});
    });

    it("matches the URL review.md sends the engine to", () => {
        const reviewMd = readFileSync(
            join(__dirname, "..", "review.md"),
            "utf8",
        );
        expect(reviewMd).toContain(
            `ANTHROPIC_BASE_URL: "${AI_ROUTER_ANTHROPIC_URL}"`,
        );
    });
});

describe("messagesHeaders", () => {
    it("sends the key and the Anthropic headers", () => {
        expect(messagesHeaders({ANTHROPIC_API_KEY: "k"})).toEqual({
            "x-api-key": "k",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        });
    });

    it("adds ANTHROPIC_CUSTOM_HEADERS, but can't override the key", () => {
        expect(
            messagesHeaders({
                ANTHROPIC_API_KEY: "k",
                ANTHROPIC_CUSTOM_HEADERS:
                    "X-Ka-Ai-Router-Config-Name: review-eval\n" +
                    "X-Ka-Ai-Router-Workload: async-test\n" +
                    "not a header\n" +
                    "x-api-key: sneaky",
            }),
        ).toEqual({
            "X-Ka-Ai-Router-Config-Name": "review-eval",
            "X-Ka-Ai-Router-Workload": "async-test",
            "x-api-key": "k",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        });
    });
});
