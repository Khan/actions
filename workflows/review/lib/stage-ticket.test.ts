import {describe, it, expect} from "vitest";

import {
    buildTicketContext,
    extractIssueKey,
    stageTicketContext,
    type TicketFetch,
} from "./stage-ticket";

/**
 * Linked-ticket staging tests. The contract under pin: ticket-context.json is
 * ALWAYS writable (every path returns a context, nothing throws), a ticket is
 * never a prerequisite (each degradation carries a machine-readable reason and
 * the prompts fall back to the PR description), and content is size-capped
 * because the file is prompt input.
 */

const OPTIONS = {
    baseUrl: "https://khanacademy.atlassian.net",
    email: "bot@khanacademy.org",
    apiToken: "tok",
    title: "Make parallel moderation the default",
    headBranch: "moderation-defaults",
    description: "Concludes the experiment.\n\nIssue: KORE-2393",
};

const ISSUE = {
    fields: {
        summary: "Moderation parallelism experiment",
        description: "Run the A/B; if latency wins, graduate everywhere.",
        status: {name: "Done"},
        resolution: {name: "Done"},
        issuetype: {name: "Task"},
        labels: ["ai-guide"],
        comment: {
            comments: [
                {
                    author: {displayName: "Susanna"},
                    created: "2026-08-01T00:00:00.000+0000",
                    body: "Experiment concluded; graduating to all configs.",
                },
            ],
        },
    },
};

const okFetch =
    (json: unknown): TicketFetch =>
    () =>
        Promise.resolve({status: 200, json});

describe("extractIssueKey", () => {
    it("prefers title over branch over description", () => {
        expect(extractIssueKey("KORE-1 x", "PROJ-2-branch", "see ABC-3")).toBe(
            "KORE-1",
        );
        expect(extractIssueKey("no key", "feature/PROJ-2", "see ABC-3")).toBe(
            "PROJ-2",
        );
        expect(extractIssueKey("no key", "no-key", "Issue: KORE-2393")).toBe(
            "KORE-2393",
        );
    });

    it("matches keys inside URLs but not lowercase hyphenated prose", () => {
        expect(
            extractIssueKey(
                "",
                "",
                "https://khanacademy.atlassian.net/browse/KORE-2510",
            ),
        ).toBe("KORE-2510");
        expect(extractIssueKey("re-123 follow-up", "fix-42", "")).toBeNull();
    });
});

describe("stageTicketContext", () => {
    it("stages the fetched ticket with url, fields, and comments", async () => {
        const {context, warnings} = await stageTicketContext(
            okFetch(ISSUE),
            OPTIONS,
        );
        expect(warnings).toEqual([]);
        expect(context).toMatchObject({
            available: true,
            key: "KORE-2393",
            url: "https://khanacademy.atlassian.net/browse/KORE-2393",
            summary: "Moderation parallelism experiment",
            status: "Done",
            resolution: "Done",
            type: "Task",
            labels: ["ai-guide"],
            truncated: false,
        });
        expect(context.comments).toEqual([
            {
                author: "Susanna",
                created: "2026-08-01T00:00:00.000+0000",
                body: "Experiment concluded; graduating to all configs.",
            },
        ]);
    });

    it("requests the ticket with Basic auth against the v2 issue endpoint", async () => {
        const calls: {url: string; headers: Record<string, string>}[] = [];
        const spyFetch: TicketFetch = (url, headers) => {
            calls.push({url, headers});
            return Promise.resolve({status: 200, json: ISSUE});
        };
        await stageTicketContext(spyFetch, {
            ...OPTIONS,
            // A trailing slash must not double up in the request URL.
            baseUrl: "https://khanacademy.atlassian.net/",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(
            "https://khanacademy.atlassian.net/rest/api/2/issue/KORE-2393?fields=summary,description,status,resolution,issuetype,labels,comment",
        );
        expect(calls[0].headers.authorization).toBe(
            `Basic ${Buffer.from("bot@khanacademy.org:tok").toString(
                "base64",
            )}`,
        );
    });

    it("stages not-configured without fetching when credentials are absent", async () => {
        const neverFetch: TicketFetch = () => {
            throw new Error("must not fetch");
        };
        for (const gap of [
            {baseUrl: ""},
            {email: ""},
            {apiToken: ""},
        ] as const) {
            const {context, warnings} = await stageTicketContext(neverFetch, {
                ...OPTIONS,
                ...gap,
            });
            expect(context).toEqual({
                available: false,
                reason: "not-configured",
            });
            expect(warnings).toEqual([]);
        }
    });

    it("stages no-issue-key when nothing ticket-shaped is referenced", async () => {
        const {context} = await stageTicketContext(okFetch(ISSUE), {
            ...OPTIONS,
            title: "fix typo",
            headBranch: "typo-fix",
            description: "no ticket here",
        });
        expect(context).toEqual({available: false, reason: "no-issue-key"});
    });

    it("degrades a 404 silently and other failures with a warning", async () => {
        const notFound = await stageTicketContext(
            () => Promise.resolve({status: 404, json: null}),
            OPTIONS,
        );
        expect(notFound.context).toEqual({
            available: false,
            reason: "not-found",
            key: "KORE-2393",
        });
        expect(notFound.warnings).toEqual([]);

        const denied = await stageTicketContext(
            () => Promise.resolve({status: 401, json: null}),
            OPTIONS,
        );
        expect(denied.context).toMatchObject({
            available: false,
            reason: "fetch-failed",
        });
        expect(denied.warnings).toHaveLength(1);

        const down = await stageTicketContext(
            () => Promise.reject(new Error("ECONNREFUSED")),
            OPTIONS,
        );
        expect(down.context).toMatchObject({
            available: false,
            reason: "fetch-failed",
        });
        expect(down.warnings[0]).toContain("ECONNREFUSED");
    });
});

describe("buildTicketContext", () => {
    it("caps description and comment sizes and keeps the LAST 20 comments", () => {
        const context = buildTicketContext(
            "KORE-1",
            "https://khanacademy.atlassian.net",
            {
                fields: {
                    summary: "s",
                    description: "d".repeat(9000),
                    comment: {
                        comments: Array.from({length: 25}, (_, i) => ({
                            author: {displayName: `a${i}`},
                            created: `c${i}`,
                            body: i === 24 ? "x".repeat(3000) : `body ${i}`,
                        })),
                    },
                },
            },
        );
        expect(context.truncated).toBe(true);
        expect(context.description?.length).toBeLessThan(9000);
        expect(context.description).toContain("[truncated]");
        expect(context.comments).toHaveLength(20);
        // Oldest-first input: the survivors are the most recent 20.
        expect(context.comments?.[0].author).toBe("a5");
        expect(context.comments?.[19].body).toContain("[truncated]");
    });

    it("tolerates a bare issue with every field missing", () => {
        const context = buildTicketContext("K-1", "https://x", {});
        expect(context).toMatchObject({
            available: true,
            key: "K-1",
            summary: "",
            resolution: null,
            labels: [],
            comments: [],
            truncated: false,
        });
    });
});
