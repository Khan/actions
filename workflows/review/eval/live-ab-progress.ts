/**
 * Progress lines for the live A/B (`live-ab.ts`), so a running job reads as
 * a tally in the actions log instead of one silent step. Run 33802457289
 * was cancelled 45 minutes in and its log went from the `tsx live-ab.ts`
 * invocation straight to "The operation was canceled": nothing said which
 * arm, case, or agent it had reached, or what it had spent.
 *
 * Everything here writes to STDERR. Stdout carries the report markdown and
 * may be parsed downstream, so a progress line there would corrupt it.
 */

import type {
    LiveAgentRequest,
    LiveAgentResult,
    LiveAgentRunner,
} from "./live-producer";

/** A progress sink: one call per line, no trailing newline. */
export type ProgressLog = (line: string) => void;

/** The default sink. `console.error` would also do, but this keeps the
 * contract explicit: progress is stderr, never stdout. */
export const stderrLog: ProgressLog = (line) => {
    process.stderr.write(`${line}\n`);
};

const usd = (value: number): string => `$${value.toFixed(2)}`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

/**
 * One dispatch's line: arm, case, agent, then what it cost and, when the
 * runner counts them, how many tool calls it made. A failure the runner can
 * see (an error message or a refusal) rides along on the same line.
 */
export const dispatchLine = (
    label: {arm: string; caseId: string},
    request: Pick<LiveAgentRequest, "name" | "model">,
    result: Pick<
        LiveAgentResult,
        "usd" | "turns" | "wallMs" | "toolCalls" | "errorMessage" | "refused"
    >,
): string => {
    const parts = [
        usd(result.usd),
        `${result.turns} turns`,
        seconds(result.wallMs),
        ...(result.toolCalls === undefined
            ? []
            : [`${result.toolCalls} tool calls`]),
        ...(result.refused === true ? ["refused"] : []),
        ...(result.errorMessage === undefined
            ? []
            : [`error: ${result.errorMessage}`]),
    ];
    return `[${label.arm}/${label.caseId}] ${request.name} (${
        request.model
    }): ${parts.join(", ")}`;
};

/** A dispatch that threw: the runner never returned a result to price. */
export const dispatchFailedLine = (
    label: {arm: string; caseId: string},
    request: Pick<LiveAgentRequest, "name" | "model">,
    error: unknown,
): string =>
    `[${label.arm}/${label.caseId}] ${request.name} (${
        request.model
    }): dispatch threw: ${String(
        error instanceof Error ? error.message : error,
    )}`;

/**
 * One scored case's line: the verdict against the expected one, the spec
 * keys caught and missed, the case's cost and the arm's running total, and
 * where the arm is in its case list.
 */
export const caseLine = (
    label: {arm: string},
    entry: {
        caseId: string;
        verdict: string;
        expected: string;
        caught: readonly string[];
        missed: readonly string[];
        usd: number;
    },
    progress: {usdSoFar: number; done: number; total: number},
): string => {
    const verdict =
        entry.verdict === entry.expected
            ? `verdict ${entry.verdict} (as expected)`
            : `verdict ${entry.verdict} (expected ${entry.expected})`;
    const keys = (list: readonly string[]): string =>
        list.length === 0 ? "none" : list.join(" ");
    return (
        `[${label.arm}/${entry.caseId}] case done: ${verdict}, ` +
        `caught ${keys(entry.caught)}, missed ${keys(entry.missed)}, ` +
        `${usd(entry.usd)} this case, ${usd(progress.usdSoFar)} so far ` +
        `(${progress.done}/${progress.total} cases)`
    );
};

/**
 * Wrap a runner so every dispatch end prints one line. Sits on the runner
 * rather than inside `produceLive` so the producer stays a pure model seam
 * and the arm and case labels come from the caller that knows them. A
 * malformed-output retry is a second dispatch and gets its own line.
 */
export const withDispatchProgress = (
    runner: LiveAgentRunner,
    label: {arm: string; caseId: string},
    log: ProgressLog = stderrLog,
): LiveAgentRunner => {
    return async (request) => {
        let result: LiveAgentResult;
        try {
            result = await runner(request);
        } catch (error) {
            log(dispatchFailedLine(label, request, error));
            throw error;
        }
        log(dispatchLine(label, request, result));
        return result;
    };
};
