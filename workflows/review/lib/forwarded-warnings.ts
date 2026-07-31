/**
 * Warnings the dispatcher can only record in a file, re-emitted from a real
 * workflow step so they become annotations.
 *
 * The dispatcher (`dispatch.ts`) runs inside the agent's Bash tool, so a
 * `::warning` it prints reaches the run log and the agent transcript but never
 * the runner's own log stream, which is what interprets workflow commands.
 * Measured on webapp#41204 run 30654454047, a deliberately mis-staged
 * `threads.json`: `dispatch-result.json` carried
 * `threadSuppressionUnavailable: {unusableThreads: 9}`, the warning text
 * appeared both in the log and in the step summary, and NO annotation across
 * the run's six jobs mentioned suppression, while the pre-agent staging step's
 * own `::warning` in that same run did annotate. A fail-open guard nobody can
 * see failing is how #302's author-spelling bug survived a whole release, so
 * the tripwire being greppable but not visible is the same failure shape one
 * layer out.
 *
 * `dispatch-gate.ts` is the consumer: it is compiled into `post-steps`, runs
 * `if: always()`, already reads every `out/` file, and its own workflow
 * commands do annotate. This lives in its own module because the gate sits at
 * its 1000-line lint ceiling.
 *
 * Determinism boundary: pure text arithmetic over already-read file contents;
 * no filesystem, no clock, no model call.
 */

import {threadSuppressionUnavailableWarning} from "./dedup";

/**
 * Every workflow-command line to re-emit for this run, given the `out/`
 * basename → raw text map the gate already built.
 *
 * Each line is REBUILT from the typed fields, never forwarded as stored text.
 * The gate step is trusted and `out/` is a directory the agent can write, so a
 * stored string could carry newlines and inject further workflow commands
 * (`::error`, `::add-mask`) into that trusted step; rebuilding from a number
 * cannot. Anything absent, non-numeric, or non-positive yields no line rather
 * than a guess, keeping this as quiet as the tripwire it forwards.
 */
export const forwardedRunWarnings = (
    outFiles: Record<string, string>,
): string[] => {
    const raw = outFiles["dispatch-result.json"];
    if (raw === undefined) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // An unparseable dispatch result is the gate's own business (it
        // already notes and reports that); nothing to forward from it.
        return [];
    }
    const count = (
        parsed as
            | {threadSuppressionUnavailable?: {unusableThreads?: unknown}}
            | undefined
    )?.threadSuppressionUnavailable?.unusableThreads;
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
        return [];
    }
    return [threadSuppressionUnavailableWarning(Math.floor(count))];
};
