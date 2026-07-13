import type {Db} from "./db";

/** Part of account deletion: remove every stored note for the user. */
export const purgeUserNotes = async (
    db: Db,
    userId: string,
): Promise<void> => {
    for (;;) {
        const notes = await db.query("Note", {userId, pageSize: 100});
        if (notes.length === 0) {
            return;
        }
        await db.deleteMulti(notes.map((note) => note.id));
    }
};
