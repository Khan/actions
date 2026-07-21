import type {Db} from "./db";

// The datastore rejects deleteMulti batches over 100 keys (see
// services/datastore/limits.md); every bulk delete must chunk.
const DELETE_CHUNK = 100;

/** Part of account deletion: remove every stored note for the user. */
export const purgeUserNotes = async (
    db: Db,
    userId: string,
): Promise<void> => {
    for (;;) {
        const notes = await db.query("Note", {
            userId,
            pageSize: DELETE_CHUNK,
        });
        if (notes.length === 0) {
            return;
        }
        await db.deleteMulti(notes.map((note) => note.id));
    }
};
