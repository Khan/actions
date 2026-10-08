/**
 * The staging CLI's direct-run body, split out of stage-pr.ts by the
 * max-lines budget (the same split check-consumer-config-cli.ts took). The
 * documented invocation stays `npx -y tsx workflows/review/lib/stage-pr.ts`:
 * that module keeps the require.main guard and calls {@link runCli}.
 */
import {runIdentity} from "./foreign-history";
import {runStagePrCli} from "./stage-pr";
import type {GhGet, StagePrFs} from "./stage-pr";
import {withGraphqlRateLimitRetry, type GhGraphql} from "./threads";

export const runCli = (): void => {
    const nodeFs = require("node:fs") as StagePrFs;
    const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
    const authHeaders = {
        accept: "application/vnd.github+json",
        ...(token !== "" ? {authorization: `Bearer ${token}`} : {}),
    };
    /**
     * One authenticated request with the shared retry policy (network failure,
     * 5xx, and rate limiting retried; any other 4xx fails the staging at
     * once). Shared by the REST reads and the GraphQL POST so both inherit the
     * same behavior on a throttled runner.
     */
    const request = async (
        path: string,
        init?: {method: string; body: string; contentType: string},
    ): Promise<unknown> => {
        const ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            let response: Awaited<ReturnType<typeof fetch>> | null = null;
            try {
                response = await fetch(`${apiUrl}${path}`, {
                    headers: {
                        ...authHeaders,
                        ...(init === undefined
                            ? {}
                            : {"content-type": init.contentType}),
                    },
                    ...(init === undefined
                        ? {}
                        : {method: init.method, body: init.body}),
                });
            } catch (error) {
                // Network-level failure: retryable.
                lastError = error;
            }
            if (response !== null) {
                if (response.ok) {
                    return await response.json();
                }
                const error = new Error(
                    `${init?.method ?? "GET"} ${path} -> ${response.status} ${
                        response.statusText
                    }`,
                );
                // GitHub's secondary rate limit surfaces as a 403 with a
                // Retry-After header, not 429; that one 4xx heals on retry.
                const retryAfterSeconds = Number(
                    response.headers.get("retry-after") ?? "",
                );
                const rateLimited =
                    response.status === 429 ||
                    (response.status === 403 && retryAfterSeconds > 0);
                if (response.status < 500 && !rateLimited) {
                    // Any other 4xx (bad token, missing PR) will not heal on
                    // retry; fail the staging immediately.
                    throw error;
                }
                lastError = error;
                if (rateLimited && retryAfterSeconds > 0) {
                    await sleep(Math.min(retryAfterSeconds, 60) * 1000);
                }
            }
            if (attempt < ATTEMPTS - 1) {
                await sleep(1000 * (attempt + 1));
            }
        }
        throw lastError;
    };
    const ghGet: GhGet = (path) => request(path);
    // The HTTP-200 `RATE_LIMITED` retry, and the transport-level
    // `assertNoGraphqlErrors` that detects it, both live in `threads.ts` so
    // autofix's port inherits them; the reader keeps its own copy of the guard.
    const ghGraphql: GhGraphql = withGraphqlRateLimitRetry(
        (query, variables) =>
            request("/graphql", {
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({query, variables}),
            }),
        sleep,
    );

    const repo = process.env.GITHUB_REPOSITORY ?? "";
    const prNumber = Number(process.env.REVIEW_PR_NUMBER ?? "");
    const repoRoot =
        process.env.REVIEW_REPO_ROOT ?? process.env.GITHUB_WORKSPACE ?? ".";
    if (repo === "" || !Number.isInteger(prNumber) || prNumber <= 0) {
        // eslint-disable-next-line no-console
        console.error(
            "::error title=review staging::GITHUB_REPOSITORY and REVIEW_PR_NUMBER are required",
        );
        process.exit(2);
    }
    // The linked-ticket GET (stage-ticket.ts). Plain fetch, no retry, and a
    // hard 10s bound per candidate, fetched in parallel (a blackholed Jira
    // host must not stall staging until the job timeout): a ticket is
    // context, not a prerequisite, and stage-ticket degrades every failure
    // rather than failing the staging.
    const ticketFetch = async (
        url: string,
        headers: Record<string, string>,
    ): Promise<{status: number; json: unknown}> => {
        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10_000),
        });
        return {
            status: response.status,
            json: await response.json().catch(() => null),
        };
    };
    void runStagePrCli(nodeFs, ghGet, ghGraphql, ticketFetch, {
        repo,
        prNumber,
        repoRoot,
        env: process.env,
        identity: runIdentity(),
    })
        .then((result) => {
            // eslint-disable-next-line no-console
            console.log(JSON.stringify(result, null, 2));
            for (const warning of result.warnings) {
                // eslint-disable-next-line no-console
                console.log(`::warning title=review staging::${warning}`);
            }
        })
        .catch((error: unknown) => {
            // eslint-disable-next-line no-console
            console.error(
                `::error title=review staging::staging failed before the agent started: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            process.exit(1);
        });
};
