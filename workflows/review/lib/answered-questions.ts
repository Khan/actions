/**
 * An answered scope question is not a fixed defect. The reconciler supplies
 * that distinction, and code verifies the question, author reply, and resolve
 * membership before preserving it for suppression. A reply alone proves none
 * of this. In particular, "fixed" on a defect question must not create memory.
 *
 * Cache entries bind to the full conversation, not the current diff. Unrelated
 * pushes should preserve an answer, but an edited or extended conversation
 * invalidates it. Missing memory falls back to posting, never to guessing.
 */
import {createHash} from "node:crypto";

import {isRecord} from "./dispatch-contracts";
import {isBotLogin, isReviewBotAuthor, sameLogin} from "./threads";

/** The dispatcher keeps older reconciler outputs valid when answered is absent. */
export type Reconciliation = {
    resolve: string[];
    keep: string[];
    answered?: string[];
    skipLines: unknown;
};

export const parseReconciliation = (
    raw: Record<string, unknown>,
): Reconciliation => {
    const ids = (key: string): string[] =>
        (Array.isArray(raw[key]) ? raw[key] : []).filter(
            (id): id is string => typeof id === "string",
        );
    return {
        resolve: ids("resolve"),
        keep: ids("keep"),
        ...(Array.isArray(raw["answered"]) ? {answered: ids("answered")} : {}),
        skipLines: raw["skipLines"] ?? [],
    };
};

export type AnsweredQuestion = {
    thread_id: string;
    author: string;
    conversation: string;
};

const records = (value: unknown): Record<string, unknown>[] =>
    (Array.isArray(value) ? value : []).filter(isRecord);

/** Mechanical preconditions only. Whether the reply answers scope is model work. */
export const hasAnsweredQuestionEvidence = (
    thread: Record<string, unknown>,
    author: unknown,
): boolean => {
    const comments = Array.isArray(thread["comments"])
        ? thread["comments"]
        : [];
    const opener = isRecord(comments[0]) ? comments[0] : undefined;
    return (
        typeof thread["thread_id"] === "string" &&
        thread["thread_id"] !== "" &&
        typeof author === "string" &&
        author.trim() !== "" &&
        !isBotLogin(author) &&
        !isReviewBotAuthor(author) &&
        typeof opener?.["author"] === "string" &&
        isReviewBotAuthor(opener["author"]) &&
        typeof opener["body"] === "string" &&
        /^\s*\*{0,2}question \(non-blocking\)\*{0,2}:?\*{0,2}\s/i.test(
            opener["body"],
        ) &&
        comments
            .slice(1)
            .some(
                (reply) =>
                    isRecord(reply) &&
                    typeof reply["author"] === "string" &&
                    sameLogin(reply["author"], author) &&
                    typeof reply["body"] === "string" &&
                    reply["body"].trim() !== "",
            )
    );
};

const conversationKey = (thread: Record<string, unknown>): string =>
    createHash("sha256")
        .update(JSON.stringify(thread["comments"]))
        .digest("hex");

/** Unknown ids, contradictory decisions, and older outputs add no memory. */
export const verifiedAnsweredQuestions = (
    threads: unknown,
    reconciliation: unknown,
    author: unknown,
): AnsweredQuestion[] => {
    const decision = isRecord(reconciliation) ? reconciliation : {};
    const ids = (key: string): unknown[] =>
        Array.isArray(decision[key]) ? decision[key] : [];
    return records(threads)
        .filter(
            (thread) =>
                ids("answered").includes(thread["thread_id"]) &&
                ids("resolve").includes(thread["thread_id"]) &&
                !ids("keep").includes(thread["thread_id"]) &&
                hasAnsweredQuestionEvidence(thread, author),
        )
        .map((thread) => ({
            thread_id: thread["thread_id"] as string,
            author: author as string,
            conversation: conversationKey(thread),
        }));
};

/** Add this run's explicit answers without changing the resolved-defect exemption. */
export const includeAnsweredQuestions = (
    adjudicated: unknown,
    threads: unknown,
    reconciliation: unknown,
    pr: unknown,
): Record<string, unknown>[] => [
    ...records(adjudicated),
    ...answeredThreadsFromMemory(
        threads,
        verifiedAnsweredQuestions(
            threads,
            reconciliation,
            isRecord(pr) ? pr["author"] : undefined,
        ),
    ),
];

/** Revalidate remembered answers against live threads before staging them. */
export const answeredThreadsFromMemory = (
    threads: unknown,
    memory: unknown,
): Record<string, unknown>[] =>
    records(threads).flatMap((thread) => {
        const entry = records(memory).find(
            (candidate) =>
                candidate["thread_id"] === thread["thread_id"] &&
                hasAnsweredQuestionEvidence(thread, candidate["author"]) &&
                candidate["conversation"] === conversationKey(thread),
        );
        return entry === undefined
            ? []
            : [{...thread, answeredBy: entry["author"]}];
    });
