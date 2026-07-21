import type {Db, Note} from "./db";
import {DEDUP_WINDOW_DAYS} from "./config";

export const saveNote = async (db: Db, note: Note): Promise<void> => {
    const existing = await db.query("Note", {
        userId: note.userId,
        pageSize: "all",
    });
    const since = note.createdAt - DEDUP_WINDOW_DAYS * 24 * 60 * 60;
    const duplicate = existing.some(
        (stored) =>
            stored.createdAt >= since && stored.content === note.content,
    );
    if (duplicate) {
        return;
    }
    await db.put(note);
};
