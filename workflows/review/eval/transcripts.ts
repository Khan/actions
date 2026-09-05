/**
 * Write sub-agent transcripts as eval artifacts, so a reviewer's
 * investigation can be READ rather than inferred from a tool-call count.
 * The count hid a reviewer reading the eval's own corpus for two full runs
 * on the Pi harness branch (actions#406); a transcript showed it in one.
 *
 * One file per dispatch attempt: `<dir>/<stage>/<case>/<agent>-<n>.json`,
 * holding a tool-call index (one line per call, capped at
 * {@link INDEX_LINE_CHARS} characters so it scans) at the top and the
 * trimmed message stream below. Tool results and long text in the messages
 * are cut to {@link TRIM_CHARS} with the trimmed length recorded, so nothing
 * looks shorter than it was. Tool-call inputs in the messages are never
 * trimmed: a Read path or Glob pattern is what the investigation pattern is
 * made of, and the index line is a pointer into them, not the record.
 *
 * Transcripts must land somewhere no reviewer can reach mid-run. The runner
 * scopes reads to the staged case, and the default directory sits beside
 * (not inside) the staging root under the OS temp dir.
 */

import {mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

/** Per-block character cap for tool results and assistant text. */
export const TRIM_CHARS = 2_000;

/** Per-line cap for the tool-call index; the messages hold the full input. */
export const INDEX_LINE_CHARS = 300;

/** Where transcripts go unless a caller says otherwise. */
export const DEFAULT_TRANSCRIPTS_DIR = join(tmpdir(), "review-transcripts");

/** One content block of an Anthropic message, loosely typed. */
type Block = Record<string, unknown>;

/** A recorded message: the SDK's `message.message` for assistant and user. */
export type TranscriptMessage = {
    role: string;
    content: unknown;
};

export type Transcript = {
    agent: string;
    model: string;
    attempt: number;
    /** `Tool key=value ...` per call, in order. */
    toolCallIndex: string[];
    toolCalls: number;
    /** Out-of-scope reads the runner's hook denied during this attempt. */
    deniedReads: number;
    /** Non-read tools the hook denied (the `tools` restriction's backstop). */
    deniedTools: number;
    messages: TranscriptMessage[];
};

const trimText = (text: string): string =>
    text.length <= TRIM_CHARS
        ? text
        : `${text.slice(0, TRIM_CHARS)}\n[trimmed ${
              text.length - TRIM_CHARS
          } more characters]`;

const trimBlock = (block: unknown): unknown => {
    if (typeof block !== "object" || block === null) {
        return typeof block === "string" ? trimText(block) : block;
    }
    const b = block as Block;
    const out: Block = {...b};
    if (typeof b["text"] === "string") {
        out["text"] = trimText(b["text"]);
    }
    if (typeof b["thinking"] === "string") {
        out["thinking"] = trimText(b["thinking"]);
    }
    // tool_result content is a string or a list of text blocks.
    if (b["type"] === "tool_result") {
        const content = b["content"];
        out["content"] = Array.isArray(content)
            ? content.map(trimBlock)
            : typeof content === "string"
            ? trimText(content)
            : content;
    }
    return out;
};

/** Trim a message's text-bearing blocks; tool_use inputs stay whole. */
export const trimMessage = (message: TranscriptMessage): TranscriptMessage => {
    const content = message.content;
    if (typeof content === "string") {
        return {...message, content: trimText(content)};
    }
    if (!Array.isArray(content)) {
        return message;
    }
    return {...message, content: content.map(trimBlock)};
};

/**
 * A summary line per tool call, so the pattern is visible at the top of the
 * file without reading the messages: `Read file_path="..." limit=...`.
 */
export const toolCallIndex = (messages: TranscriptMessage[]): string[] => {
    const lines: string[] = [];
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }
        for (const block of message.content as Block[]) {
            if (block["type"] !== "tool_use") {
                continue;
            }
            const args = (block["input"] ?? {}) as Block;
            const argText = Object.entries(args)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(" ");
            lines.push(
                `${String(block["name"])} ${argText}`.slice(
                    0,
                    INDEX_LINE_CHARS,
                ),
            );
        }
    }
    return lines;
};

const safe = (part: string): string => part.replaceAll(/[^A-Za-z0-9._-]/g, "_");

/**
 * Write `<dir>/<label>/<agent>-<attempt>.json` and return its path. `label`
 * groups one case's agents (stage and case id, as path segments).
 */
export const writeTranscript = (
    dir: string,
    label: string[],
    transcript: Omit<Transcript, "toolCallIndex" | "toolCalls" | "messages"> & {
        messages: TranscriptMessage[];
    },
): string => {
    const messages = transcript.messages.map(trimMessage);
    const index = toolCallIndex(transcript.messages);
    const target = join(dir, ...label.map(safe));
    mkdirSync(target, {recursive: true});
    const file = join(
        target,
        `${safe(transcript.agent)}-${transcript.attempt}.json`,
    );
    const body: Transcript = {
        agent: transcript.agent,
        model: transcript.model,
        attempt: transcript.attempt,
        toolCallIndex: index,
        toolCalls: index.length,
        deniedReads: transcript.deniedReads,
        deniedTools: transcript.deniedTools,
        messages,
    };
    writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
};
