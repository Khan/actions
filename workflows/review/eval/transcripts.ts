/**
 * Write sub-agent transcripts as eval artifacts, so a model's investigation
 * can be READ rather than inferred from tool-call counts. The smoke writes
 * one per agent on its single live case; the live A/B writes them when
 * `REVIEW_EVAL_TRANSCRIPTS=1` (a 10-case run is ~400 files, so it is opt-in
 * there). Tool results and long text are trimmed to keep a transcript
 * readable in a browser; the trimmed length is recorded so nothing looks
 * shorter than it was.
 */

import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

import type {AgentTranscript} from "../lib/dispatch-runner-pi";

/** Per-block character cap for tool results and assistant text. */
const TRIM_CHARS = 2_000;

/**
 * Outside the repo tree on purpose. The first version wrote under the
 * repo's `out/`, and the smoke linked the repo into the case checkout, so
 * a reviewer read a sibling agent's transcript mid-run (run 33793491316,
 * `tail -n 30 .../skill-auditor.json`). Nothing a reviewer can reach may
 * be written during a run.
 */
export const TRANSCRIPTS_DIR = "/tmp/review-transcripts";

const trimText = (text: string): string =>
    text.length <= TRIM_CHARS
        ? text
        : `${text.slice(0, TRIM_CHARS)}\n[trimmed ${
              text.length - TRIM_CHARS
          } more characters]`;

/**
 * Trim a message's text-bearing content blocks. Tool-call arguments are
 * kept whole: they are what the investigation pattern is made of, and a
 * Read path or Grep pattern is short.
 */
const trimMessage = (message: unknown): unknown => {
    if (typeof message !== "object" || message === null) {
        return message;
    }
    const record = message as Record<string, unknown>;
    const content = record["content"];
    if (!Array.isArray(content)) {
        return message;
    }
    return {
        ...record,
        content: content.map((block: unknown) => {
            if (typeof block !== "object" || block === null) {
                return block;
            }
            const b = block as Record<string, unknown>;
            const out: Record<string, unknown> = {...b};
            if (typeof b["text"] === "string") {
                out["text"] = trimText(b["text"]);
            }
            if (typeof b["thinking"] === "string") {
                out["thinking"] = trimText(b["thinking"]);
            }
            return out;
        }),
    };
};

/**
 * A summary line per tool call, so the pattern is visible at the top of the
 * file without reading the messages: `Read path=... offset=... limit=...`.
 */
const toolCallIndex = (messages: unknown[]): string[] => {
    const lines: string[] = [];
    for (const message of messages) {
        const record = message as {role?: string; content?: unknown[]};
        if (record.role !== "assistant" || !Array.isArray(record.content)) {
            continue;
        }
        for (const block of record.content as Record<string, unknown>[]) {
            if (block["type"] !== "toolCall") {
                continue;
            }
            const args = (block["arguments"] ?? {}) as Record<string, unknown>;
            const argText = Object.entries(args)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ");
            lines.push(`${String(block["name"])} ${argText}`.slice(0, 300));
        }
    }
    return lines;
};

/**
 * Token totals across the agent's assistant turns, from the usage pi-ai puts
 * on every assistant message. Tool calls are a proxy for cost; this is the
 * cost's actual composition. `reasoning` is the share billed as output that
 * no tool-call change touches (gemini at effort high, claude adaptive), and
 * `cacheRead` is what re-reading the context each turn cost.
 */
export type TokenTotals = {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
};

export const tokenTotals = (messages: unknown[]): TokenTotals => {
    const totals: TokenTotals = {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
    };
    for (const message of messages) {
        const record = message as {
            role?: string;
            usage?: Record<string, unknown>;
        };
        if (record.role !== "assistant" || record.usage === undefined) {
            continue;
        }
        for (const key of Object.keys(totals) as (keyof TokenTotals)[]) {
            const value = record.usage[key];
            if (typeof value === "number") {
                totals[key] += value;
            }
        }
    }
    return totals;
};

const safe = (part: string): string => part.replaceAll(/[^A-Za-z0-9._-]/g, "_");

/**
 * Write `<dir>/<label>/<agent>.json`. `label` groups one case's agents (the
 * case id, plus the arm where the caller knows it).
 */
export const writeTranscript = (
    label: string,
    transcript: AgentTranscript,
    dir: string = TRANSCRIPTS_DIR,
): string => {
    const target = join(dir, safe(label));
    mkdirSync(target, {recursive: true});
    const path = join(target, `${safe(transcript.name)}.json`);
    const index = toolCallIndex(transcript.messages);
    // Distinct-call count is the first thing to compare against the total:
    // total >> distinct is a loop, total ~ distinct is exploration.
    const distinct = new Set(index).size;
    writeFileSync(
        path,
        JSON.stringify(
            {
                name: transcript.name,
                model: transcript.model,
                ended: transcript.ended,
                turns: transcript.turns,
                toolCalls: transcript.toolCalls,
                distinctToolCalls: distinct,
                usd: transcript.usd,
                tokens: tokenTotals(transcript.messages),
                wallMs: transcript.wallMs,
                toolCallIndex: index,
                messages: transcript.messages.map(trimMessage),
            },
            null,
            2,
        ),
    );
    return path;
};
