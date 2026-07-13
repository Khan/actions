import {memDb, note} from "./testing";
import {MAX_NOTES_PER_USER, pruneNotes, saveNote} from "./retention";

const count = async (db: ReturnType<typeof memDb>): Promise<number> =>
    (await db.query("Note", {userId: "u1", pageSize: "all"})).length;

describe("retention", () => {
    it("caps stored notes per user", async () => {
        const db = memDb();
        for (let i = 0; i < MAX_NOTES_PER_USER + 5; i++) {
            await saveNote(db, note("u1", `note ${i}`));
        }
        await pruneNotes(db, "u1");
        expect(await count(db)).toBeLessThanOrEqual(MAX_NOTES_PER_USER);
    });

    it("dedups an identical note inside the window", async () => {
        const db = memDb();
        await saveNote(db, note("u1", "same content"));
        await saveNote(db, note("u1", "same content"));
        expect(await count(db)).toBe(1);
    });

    it("keeps distinct notes that share a prefix", async () => {
        const db = memDb();
        await saveNote(db, note("u1", "prefix: alpha"));
        await saveNote(db, note("u1", "prefix: beta"));
        expect(await count(db)).toBe(2);
    });
});
