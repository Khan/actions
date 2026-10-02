/**
 * Where model calls go when nothing else says: ai-router (AICODE-31).
 *
 * In the Actions sandbox the firewall api-proxy sets ANTHROPIC_BASE_URL, so
 * this default only kicks in for local and bare-runner eval runs.  To run an
 * eval locally:
 *
 *   # prod ai-router (the default), with your own ai-router token.  Ask in
 *   # #khanmigo-infrastructure for one, or mint it yourself from webapp if
 *   # you have prod datastore access:
 *   #   go run ./services/ai-router/cmd/tokens create --prod \
 *   #     --owner you@khanacademy.org --purpose 'review eval'
 *   ANTHROPIC_API_KEY=khan-ai-router_...
 *
 *   # ai-router on your laptop (webapp: make start-dev-server WORKING_ON=ai-router),
 *   # with the dev token it mints into genfiles/devserver/ai-router/secrets.env
 *   ANTHROPIC_BASE_URL=http://localhost:8134/api/internal/_ai-router/anthropic
 *   ANTHROPIC_API_KEY=$LOCAL_AI_ROUTER_TOKEN
 *
 *   # Anthropic direct
 *   ANTHROPIC_BASE_URL=https://api.anthropic.com
 *   ANTHROPIC_API_KEY=sk-ant-...
 *
 * A dev token only works against your local ai-router, and a prod one only
 * against prod (and ZNDs).  The wrong one is a 403.
 */

// review.md's engine.env carries the same URL; anthropic-api.test.ts fails if
// the two drift.
export const AI_ROUTER_ANTHROPIC_URL =
    "https://ai-router-6fmjyrz2lq-uc.a.run.app/api/internal/_ai-router/anthropic";

type Env = Record<string, string | undefined>;

/** For an Agent SDK `env` option, which replaces the subprocess env. */
export const withRouterDefault = (env: Env = process.env): Env => ({
    ...env,
    ANTHROPIC_BASE_URL: env["ANTHROPIC_BASE_URL"] || AI_ROUTER_ANTHROPIC_URL,
});

export const messagesUrl = (env: Env = process.env): string => {
    const base = withRouterDefault(env)["ANTHROPIC_BASE_URL"] ?? "";
    return `${base.replace(/\/+$/, "")}/v1/messages`;
};

/**
 * ANTHROPIC_CUSTOM_HEADERS is newline-separated `Name: Value` (Claude Code's
 * format), so `X-Ka-Ai-Router-*` tags reach ai-router from raw calls too.
 */
export const messagesHeaders = (
    env: Env = process.env,
): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const line of (env["ANTHROPIC_CUSTOM_HEADERS"] ?? "").split("\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) {
            continue;
        }
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return {
        ...headers,
        "x-api-key": env["ANTHROPIC_API_KEY"] ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    };
};
