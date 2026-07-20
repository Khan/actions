import {memDb, note} from "./testing";
import {MAX_NOTES_PER_USER, pruneNotes, saveNote} from "./retention";

const count = async (db: ReturnType<typeof memDb>): Promise<number> =>
    (await db.query("Note", {userId: "u1", pageSize: "all"})).length;

describe("retention", () => {
    it("caps stored notes per user, clearing a large backlog", async () => {
        const db = memDb();
        for (let i = 0; i < MAX_NOTES_PER_USER + 150; i++) {
            await db.put(note("u1", `imported ${i}`));
        }
        await saveNote(db, note("u1", "fresh"));
        await pruneNotes(db, "u1");
        expect(await count(db)).toBe(MAX_NOTES_PER_USER);
    });
});
