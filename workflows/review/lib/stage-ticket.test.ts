import {describe, it, expect} from "vitest";

import {
    buildTicketContext,
    extractIssueKey,
    parseProjectAllowlist,
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
    projects: "KORE",
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

const PROJECTS = ["KORE", "PROJ", "ABC"];

describe("extractIssueKey", () => {
    it("prefers title over branch over description", () => {
        expect(
            extractIssueKey("KORE-1 x", "PROJ-2-branch", "see ABC-3", PROJECTS),
        ).toBe("KORE-1");
        expect(
            extractIssueKey("no key", "feature/PROJ-2", "see ABC-3", PROJECTS),
        ).toBe("PROJ-2");
        expect(
            extractIssueKey("no key", "no-key", "Issue: KORE-2393", PROJECTS),
        ).toBe("KORE-2393");
    });

    it("matches keys inside URLs but not lowercase hyphenated prose", () => {
        expect(
            extractIssueKey(
                "",
                "",
                "https://khanacademy.atlassian.net/browse/KORE-2510",
                PROJECTS,
            ),
        ).toBe("KORE-2510");
        expect(
            extractIssueKey("re-123 follow-up", "fix-42", "", PROJECTS),
        ).toBeNull();
    });

    it("skips key-shaped tokens outside the project allowlist", () => {
        // UTF-8, SHA-256, CVE-2024-1234 all match the key regex; without the
        // allowlist gate the first would win and block the real key.
        expect(
            extractIssueKey(
                "Fix UTF-8 handling for KORE-123",
                "",
                "",
                PROJECTS,
            ),
        ).toBe("KORE-123");
        expect(
            extractIssueKey(
                "Bump to SHA-256 digests (PROJ-9)",
                "",
                "Handle CVE-2024-1234 in deps",
                PROJECTS,
            ),
        ).toBe("PROJ-9");
        expect(
            extractIssueKey("Handle CVE-2024-1234 in deps", "", "", PROJECTS),
        ).toBeNull();
    });

    it("takes the LAST allowed key in the description", () => {
        // The `~/bin/gh` convention puts the tracking key at the END of the
        // body, after any tickets the prose mentions (this repo's own PR
        // bodies mention e.g. PRA-43 before the trailing KORE link).
        expect(
            extractIssueKey(
                "no key",
                "no-key",
                "tracked separately (ABC-43). More prose.\n\n[KORE-2510](https://x/browse/KORE-2510)",
                PROJECTS,
            ),
        ).toBe("KORE-2510");
    });
});

describe("parseProjectAllowlist", () => {
    it("splits, trims, uppercases, and drops empties", () => {
        expect(parseProjectAllowlist("KORE, fei,,PRA ")).toEqual([
            "KORE",
            "FEI",
            "PRA",
        ]);
        expect(parseProjectAllowlist("")).toEqual([]);
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

    it("stages not-configured with a warning when only the allowlist is missing", async () => {
        // Credentials without REVIEW_JIRA_PROJECTS is a half-configured
        // consumer: same degradation, but visibly.
        const neverFetch: TicketFetch = () => {
            throw new Error("must not fetch");
        };
        const {context, warnings} = await stageTicketContext(neverFetch, {
            ...OPTIONS,
            projects: "",
        });
        expect(context).toEqual({available: false, reason: "not-configured"});
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("REVIEW_JIRA_PROJECTS");
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

    it("degrades a 200 whose body is not a Jira issue", async () => {
        // The production fetch wrapper stages `json: null` for any
        // unparseable 200 body (an SSO login page on a misconfigured host).
        for (const json of [null, "<html>", [1]]) {
            const {context, warnings} = await stageTicketContext(
                okFetch(json),
                OPTIONS,
            );
            expect(context).toEqual({
                available: false,
                reason: "fetch-failed",
                key: "KORE-2393",
            });
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("non-issue body");
        }
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
        // Belt and braces: the null-body guard lives in stageTicketContext,
        // but this function must not throw either.
        expect(buildTicketContext("K-1", "https://x", null)).toMatchObject({
            available: true,
            key: "K-1",
            comments: [],
        });
    });

    it("marks a partial comment page truncated via the envelope total", () => {
        // Jira's `comment` field is a pagination envelope: `comments` is one
        // page and `total` the true count, so a long ticket's tail can live
        // beyond the page even under this module's own cap.
        const context = buildTicketContext("K-1", "https://x", {
            fields: {
                comment: {
                    comments: [{body: "only one staged"}],
                    total: 60,
                },
            },
        });
        expect(context.truncated).toBe(true);
        expect(context.comments).toHaveLength(1);
    });
});
