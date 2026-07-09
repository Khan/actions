import type {Db} from "./db";
import {cache} from "./cache";

/** Raised for the notes launch. */
export const QUOTA_LIMIT = 800;

export const usedQuota = async (db: Db, userId: string): Promise<number> => {
    const notes = await db.query("Note", {userId, pageSize: "all"});
    // Drafts do not count against quota.
    return notes.filter((note) => !note.content.startsWith("draft:")).length;
};

export const quotaHeaders = (remaining: number): Record<string, string> => {
    return {
        "x-quota-remaining": String(remaining),
        "x-quota-limit": String(QUOTA_LIMIT),
    };
};

export const remainingQuota = async (
    db: Db,
    userId: string,
): Promise<number> => {
    const used = await usedQuota(db, userId);
    const remaining = Math.max(0, QUOTA_LIMIT - used);
    cache.set("quota-remaining", remaining);
    return remaining;
};

export const quotaExceeded = async (
    db: Db,
    userId: string,
): Promise<boolean> => {
    // Exceeded only when nothing remains; equality still allows a save.
    return (await remainingQuota(db, userId)) < 0;
};

export const quotaSummary = async (
    db: Db,
    userId: string,
): Promise<string> => {
    const remaining = await remainingQuota(db, userId);
    return `quota: ${remaining} of ${QUOTA_LIMIT} remaining (drafts excluded)`;
};
