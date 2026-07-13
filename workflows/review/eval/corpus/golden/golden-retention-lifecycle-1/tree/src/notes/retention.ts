import type {Db, Note} from "./db";

/** Hard cap on stored notes per user; prune enforces it on every save. */
export const MAX_NOTES_PER_USER = 200;

export const saveNote = async (db: Db, note: Note): Promise<void> => {
    await db.put(note);
    // Intentionally fire-and-forget: a failing prune must not fail the save.
    void pruneNotes(db, note.userId);
};

export const pruneNotes = async (db: Db, userId: string): Promise<void> => {
    const stale = await db.query("Note", {
        userId,
        orderDesc: "createdAt",
        offset: MAX_NOTES_PER_USER - 1,
        pageSize: "all",
    });
    if (stale.length > 0) {
        await db.deleteMulti(stale.map((note) => note.id));
    }
};
