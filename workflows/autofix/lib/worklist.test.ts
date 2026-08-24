import {describe, expect, it} from "vitest";

import {buildBodyWorkList, buildWorkList} from "./worklist.ts";
import type {CollapsedObservation} from "./collapsed.ts";
import type {StagedThread} from "../../review/lib/rereview.ts";
import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
} from "../../review/lib/render-comment.ts";

const thread = (
    over: Partial<StagedThread> & {body: string},
): StagedThread => ({
    thread_id: over.thread_id ?? "T1",
    path: over.path ?? "src/a.ts",
    line: over.line === undefined ? 12 : over.line,
    url: over.url,
    comments: over.comments ?? [
        {author: "github-actions[bot]", body: over.body},
    ],
});

const BLOCKING = [...BLOCKING_LABELS];
const NITS = [...NON_BLOCKING_LABELS];

describe("buildWorkList", () => {
    it("selects threads whose label is in scope", () => {
        const {items, skipped} = buildWorkList(
            [thread({body: "**issue (blocking):** null deref here"})],
            BLOCKING,
        );
        expect(skipped).toEqual([]);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            threadId: "T1",
            path: "src/a.ts",
            line: 12,
            label: "issue (blocking)",
        });
    });

    it("skips threads whose label is out of scope", () => {
        const {items, skipped} = buildWorkList(
            [thread({body: "**nitpick (non-blocking):** rename this"})],
            BLOCKING,
        );
        expect(items).toEqual([]);
        expect(skipped).toEqual([
            {
                threadId: "T1",
                path: "src/a.ts",
                reason: "out-of-scope",
                label: "nitpick (non-blocking)",
            },
        ]);
    });

    it("reads the markdown-stripped label form the staging can produce", () => {
        // Khan/webapp#40561: staged openers arrived without the ** wrapping.
        const {items} = buildWorkList(
            [thread({body: "issue (blocking): unbounded read"})],
            BLOCKING,
        );
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe("issue (blocking)");
    });

    it("excludes a thread whose label will not parse", () => {
        // Fail-closed, inverted from rereview.ts: an unclassifiable finding is
        // the last thing an agent should be editing code on the strength of.
        const {items, skipped} = buildWorkList(
            [thread({body: "please just fix this thanks"})],
            [...BLOCKING, ...NITS],
        );
        expect(items).toEqual([]);
        expect(skipped[0]).toMatchObject({reason: "unparseable-label"});
        expect(skipped[0].label).toBeUndefined();
    });

    it("excludes an outdated thread whose anchor is gone", () => {
        const {items, skipped} = buildWorkList(
            [thread({body: "**issue (blocking):** stale", line: null})],
            BLOCKING,
        );
        expect(items).toEqual([]);
        expect(skipped[0]).toMatchObject({
            reason: "outdated-anchor",
            label: "issue (blocking)",
        });
    });

    it("excludes a malformed line rather than passing it downstream", () => {
        const staged = {
            ...thread({body: "**issue (blocking):** x"}),
            line: "12" as unknown as number,
        };
        const {items, skipped} = buildWorkList([staged], BLOCKING);
        expect(items).toEqual([]);
        expect(skipped[0].reason).toBe("outdated-anchor");
    });

    it("keeps the bot's opening comment verbatim as the finding statement", () => {
        const body = "**issue (blocking):** the `x` guard is inverted\n\nmore";
        const {items} = buildWorkList([thread({body})], BLOCKING);
        expect(items[0].body).toBe(body);
    });

    it("carries the thread url when staged and omits it when not", () => {
        const withUrl = buildWorkList(
            [
                thread({
                    body: "**issue (blocking):** x",
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                }),
            ],
            BLOCKING,
        );
        expect(withUrl.items[0].url).toBe(
            "https://github.com/o/r/pull/1#discussion_r1",
        );
        const withoutUrl = buildWorkList(
            [thread({body: "**issue (blocking):** x"})],
            BLOCKING,
        );
        expect("url" in withoutUrl.items[0]).toBe(false);
    });

    it("preserves staged order so the plan is stable across runs", () => {
        const threads = ["T1", "T2", "T3"].map((id) =>
            thread({thread_id: id, body: "**issue (blocking):** x"}),
        );
        const {items} = buildWorkList(threads, BLOCKING);
        expect(items.map((i) => i.threadId)).toEqual(["T1", "T2", "T3"]);
    });

    it("selects both classes when both scopes are unioned", () => {
        const {items} = buildWorkList(
            [
                thread({thread_id: "T1", body: "**issue (blocking):** a"}),
                thread({
                    thread_id: "T2",
                    body: "**suggestion (non-blocking):** b",
                }),
            ],
            [...BLOCKING, ...NITS],
        );
        expect(items.map((i) => i.threadId)).toEqual(["T1", "T2"]);
    });
});

describe("thread ownership", () => {
    it("excludes a thread a human opened, even with a blocking-looking label", () => {
        // Khan/actions#298 review: nothing downstream would stop a human thread
        // whose first line quotes the reviewer's label from becoming a work
        // item that an agent then edits code for.
        const {items, skipped} = buildWorkList(
            [
                {
                    ...thread({body: "x"}),
                    comments: [
                        {author: "alice", body: "**issue (blocking):** boom"},
                    ],
                },
            ],
            BLOCKING,
        );
        expect(items).toEqual([]);
        expect(skipped[0].reason).toBe("not-reviewer-thread");
    });

    it("excludes a thread with no comments at all", () => {
        const {items, skipped} = buildWorkList(
            [{...thread({body: ""}), comments: []}],
            BLOCKING,
        );
        expect(items).toEqual([]);
        expect(skipped[0].reason).toBe("not-reviewer-thread");
    });

    it("honours a configured bot login", () => {
        const staged = {
            ...thread({body: "x"}),
            comments: [{author: "other-bot", body: "**issue (blocking):** b"}],
        };
        expect(buildWorkList([staged], BLOCKING).items).toEqual([]);
        expect(
            buildWorkList([staged], BLOCKING, "other-bot").items,
        ).toHaveLength(1);
    });
});

describe("buildBodyWorkList", () => {
    const observation = (over: Partial<CollapsedObservation> = {}) => ({
        path: "src/a.ts",
        line: 12,
        label: "suggestion (non-blocking, documentation)",
        subject: "Trim the doc comment.",
        ...over,
    });

    it("selects in-scope observations as review-body items", () => {
        const {items, skipped} = buildBodyWorkList(
            [observation()],
            ["suggestion (non-blocking, documentation)"],
            [],
        );
        expect(skipped).toEqual([]);
        expect(items).toEqual([
            {
                threadId: "review-body:src/a.ts:12:suggestion",
                path: "src/a.ts",
                line: 12,
                label: "suggestion (non-blocking, documentation)",
                body: "Trim the doc comment.",
            },
        ]);
    });

    it("skips out-of-scope observations, recording the label", () => {
        const {items, skipped} = buildBodyWorkList(
            [observation({label: "question (non-blocking)"})],
            ["suggestion (non-blocking, documentation)"],
            [],
        );
        expect(items).toEqual([]);
        expect(skipped).toEqual([
            {
                threadId: "review-body:src/a.ts:12:question",
                path: "src/a.ts",
                reason: "out-of-scope",
                label: "question (non-blocking)",
            },
        ]);
    });

    it("skips an observation whose anchor an open thread already covers", () => {
        const {items, skipped} = buildBodyWorkList(
            [observation()],
            ["suggestion (non-blocking, documentation)"],
            [thread({body: "**suggestion (non-blocking):** same spot"})],
        );
        expect(items).toEqual([]);
        expect(skipped[0]).toMatchObject({reason: "thread-covered"});
    });
});
