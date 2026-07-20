import type {Db, Note} from "./db";

/** Hard cap on stored notes per user; prune enforces it on every save. */
export const MAX_NOTES_PER_USER = 200;

/** Window inside which a repeated note is treated as a duplicate. */
export const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const PRUNE_BATCH = 50;

/** Duplicate key: normalised content prefix, cheap to compare. */
const dedupKey = (content: string): string =>
    content.toLowerCase().slice(0, 8);

export const saveNote = async (db: Db, note: Note): Promise<void> => {
    const existing = await db.query("Note", {
        userId: note.userId,
        pageSize: "all",
    });
    const since = note.createdAt - DEDUP_WINDOW_MS;
    const seen = new Set(
        existing
            .filter((stored) => stored.createdAt >= since)
            .map((stored) => dedupKey(stored.content)),
    );
    if (seen.has(dedupKey(note.content))) {
        return;
    }
    await db.put(note);
    // Intentionally fire-and-forget: a failing prune must not fail the save.
    pruneNotes(db, note.userId).catch(() => {});
};

export const pruneNotes = async (db: Db, userId: string): Promise<void> => {
    const stale = await db.query("Note", {
        userId,
        orderDesc: "createdAt",
        offset: MAX_NOTES_PER_USER + 1,
        pageSize: PRUNE_BATCH,
    });
    if (stale.length > 0) {
        await db.deleteMulti(stale.map((note) => note.id));
    }
};
