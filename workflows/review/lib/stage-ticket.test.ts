import {describe, it, expect} from "vitest";

import {
    buildStagedTicket,
    extractIssueKeys,
    MAX_TICKET_FETCHES,
    stageTicketContext,
    type TicketFetch,
} from "./stage-ticket";

/**
 * Linked-ticket staging tests. The contract under pin: ticket-context.json is
 * ALWAYS writable (every path returns a context, nothing throws), a ticket is
 * never a prerequisite (each degradation carries a machine-readable reason and
 * the prompts fall back to the PR description), known key-shaped noise sinks
 * below plausible keys before the fetch cap applies (so it can't spend the
 * budget; survivors 404 out), and content is size-capped because the file is
 * prompt input.
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

/** A fetch that resolves some keys and 404s the rest. */
const fetchByKey =
    (issues: Record<string, unknown>): TicketFetch =>
    (url) => {
        const key = /issue\/([A-Z0-9-]+)\?/.exec(url)?.[1] ?? "";
        return Promise.resolve(
            key in issues
                ? {status: 200, json: issues[key]}
                : {status: 404, json: null},
        );
    };

describe("extractIssueKeys", () => {
    it("collects every candidate in order of appearance, deduped", () => {
        expect(
            extractIssueKeys(
                "KORE-1 x",
                "feature/PROJ-2",
                "see ABC-3, then KORE-1 again",
            ),
        ).toEqual(["KORE-1", "PROJ-2", "ABC-3"]);
        expect(extractIssueKeys("no key", "no-key", "none here")).toEqual([]);
    });

    it("keeps key-shaped noise as candidates, sunk below plausible keys", () => {
        // UTF-8, SHA-256, CVE-2024-1234 all match the key regex; they stay
        // candidates (the fetch 404s them out) but sort behind anything not
        // on the known-noise list.
        expect(
            extractIssueKeys("Fix UTF-8 handling for KORE-123", "", ""),
        ).toEqual(["KORE-123", "UTF-8"]);
    });

    it("never lets known noise crowd a real key out of the fetch cap", () => {
        // The regression that motivated the sink, reproduced from a real PR
        // body: four noise tokens ahead of the real key leave it one slot
        // from being sliced off. With the sink, the real keys always land
        // inside the cap.
        const keys = extractIssueKeys(
            "Fix UTF-8 and SHA-256 handling",
            "",
            "Covers CVE-2024-1234 and RFC-9110, ISO-8601 dates; see KORE-2510",
        );
        expect(keys).toHaveLength(MAX_TICKET_FETCHES);
        expect(keys[0]).toBe("KORE-2510");
    });

    it("matches keys inside URLs but not lowercase hyphenated prose", () => {
        expect(
            extractIssueKeys(
                "",
                "",
                "https://khanacademy.atlassian.net/browse/KORE-2510",
            ),
        ).toEqual(["KORE-2510"]);
        expect(extractIssueKeys("re-123 follow-up", "fix-42", "")).toEqual([]);
    });

    it("caps the candidate list", () => {
        const description = Array.from(
            {length: 10},
            (_, i) => `KORE-${i}`,
        ).join(" ");
        expect(extractIssueKeys("", "", description)).toHaveLength(
            MAX_TICKET_FETCHES,
        );
    });
});

describe("stageTicketContext", () => {
    it("stages the fetched ticket with url, fields, and comments", async () => {
        const {context, warnings} = await stageTicketContext(
            okFetch(ISSUE),
            OPTIONS,
        );
        expect(warnings).toEqual([]);
        expect(context.available).toBe(true);
        if (!context.available) {
            throw new Error("unreachable");
        }
        expect(context.tickets).toHaveLength(1);
        expect(context.tickets[0]).toMatchObject({
            key: "KORE-2393",
            url: "https://khanacademy.atlassian.net/browse/KORE-2393",
            summary: "Moderation parallelism experiment",
            status: "Done",
            resolution: "Done",
            type: "Task",
            labels: ["ai-guide"],
            truncated: false,
        });
        expect(context.tickets[0].comments).toEqual([
            {
                author: "Susanna",
                created: "2026-08-01T00:00:00.000+0000",
                body: "Experiment concluded; graduating to all configs.",
            },
        ]);
    });

    it("stages every ticket the PR references, in candidate order", async () => {
        const {context, warnings} = await stageTicketContext(
            fetchByKey({
                "KORE-1": {fields: {summary: "first"}},
                "ABC-3": {fields: {summary: "third"}},
            }),
            {
                ...OPTIONS,
                title: "KORE-1: do the thing",
                headBranch: "kore1",
                description: "relates to PROJ-2 and ABC-3",
            },
        );
        expect(warnings).toEqual([]);
        expect(context).toMatchObject({available: true});
        if (!context.available) {
            throw new Error("unreachable");
        }
        // PROJ-2 404d (noise or not browsable) and dropped silently.
        expect(context.tickets.map((t) => t.key)).toEqual(["KORE-1", "ABC-3"]);
    });

    it("never lets key-shaped noise block a real key", async () => {
        const {context} = await stageTicketContext(
            fetchByKey({"KORE-123": {fields: {summary: "real"}}}),
            {
                ...OPTIONS,
                title: "Fix UTF-8 handling for KORE-123",
                headBranch: "",
                description: "Handle CVE-2024-1234 in deps",
            },
        );
        expect(context).toMatchObject({available: true});
        if (!context.available) {
            throw new Error("unreachable");
        }
        expect(context.tickets.map((t) => t.key)).toEqual(["KORE-123"]);
    });

    it("requests each ticket with Basic auth against the v2 issue endpoint", async () => {
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

    it("stages no-issue-key when nothing key-shaped is referenced", async () => {
        const {context} = await stageTicketContext(okFetch(ISSUE), {
            ...OPTIONS,
            title: "fix typo",
            headBranch: "typo-fix",
            description: "no ticket here",
        });
        expect(context).toEqual({available: false, reason: "no-issue-key"});
    });

    it("degrades all-404 silently and auth/network failures with warnings", async () => {
        const notFound = await stageTicketContext(fetchByKey({}), OPTIONS);
        expect(notFound.context).toEqual({
            available: false,
            reason: "not-found",
        });
        expect(notFound.warnings).toEqual([]);

        // 400 is the same candidate noise in malformed-key form: silent.
        const malformed = await stageTicketContext(
            () => Promise.resolve({status: 400, json: null}),
            OPTIONS,
        );
        expect(malformed.context).toEqual({
            available: false,
            reason: "not-found",
        });
        expect(malformed.warnings).toEqual([]);

        const denied = await stageTicketContext(
            () => Promise.resolve({status: 401, json: null}),
            OPTIONS,
        );
        expect(denied.context).toEqual({
            available: false,
            reason: "fetch-failed",
        });
        expect(denied.warnings).toHaveLength(1);
        expect(denied.warnings[0]).toContain("fall back");

        const down = await stageTicketContext(
            () => Promise.reject(new Error("ECONNREFUSED")),
            OPTIONS,
        );
        expect(down.context).toEqual({
            available: false,
            reason: "fetch-failed",
        });
        expect(down.warnings[0]).toContain("ECONNREFUSED");
    });

    it("stages the survivors when one candidate fails and another resolves", async () => {
        const flaky: TicketFetch = (url) =>
            url.includes("KORE-1?")
                ? Promise.reject(new Error("ETIMEDOUT"))
                : Promise.resolve({status: 200, json: ISSUE});
        const {context, warnings} = await stageTicketContext(flaky, {
            ...OPTIONS,
            title: "KORE-1 and KORE-2393",
            headBranch: "",
            description: "",
        });
        expect(context).toMatchObject({available: true});
        if (!context.available) {
            throw new Error("unreachable");
        }
        expect(context.tickets.map((t) => t.key)).toEqual(["KORE-2393"]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("ETIMEDOUT");
        expect(warnings[0]).toContain("other tickets staged");
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
            });
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("non-issue body");
        }
    });
});

describe("buildStagedTicket", () => {
    it("caps description and comment sizes and keeps the LAST 20 comments", () => {
        const ticket = buildStagedTicket(
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
        expect(ticket.truncated).toBe(true);
        expect(ticket.description.length).toBeLessThan(9000);
        expect(ticket.description).toContain("[truncated]");
        expect(ticket.comments).toHaveLength(20);
        // Oldest-first input: the survivors are the most recent 20.
        expect(ticket.comments[0].author).toBe("a5");
        expect(ticket.comments[19].body).toContain("[truncated]");
    });

    it("tolerates a bare issue with every field missing", () => {
        const ticket = buildStagedTicket("K-1", "https://x", {});
        expect(ticket).toMatchObject({
            key: "K-1",
            summary: "",
            resolution: null,
            labels: [],
            comments: [],
            truncated: false,
        });
        // Belt and braces: the null-body guard lives in stageTicketContext,
        // but this function must not throw either.
        expect(buildStagedTicket("K-1", "https://x", null)).toMatchObject({
            key: "K-1",
            comments: [],
        });
    });

    it("marks a partial comment page truncated via the envelope total", () => {
        // Jira's `comment` field is a pagination envelope: `comments` is one
        // page and `total` the true count, so a long ticket's tail can live
        // beyond the page even under this module's own cap.
        const ticket = buildStagedTicket("K-1", "https://x", {
            fields: {
                comment: {
                    comments: [{body: "only one staged"}],
                    total: 60,
                },
            },
        });
        expect(ticket.truncated).toBe(true);
        expect(ticket.comments).toHaveLength(1);
    });
});
