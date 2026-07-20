import {memDb, note} from "./testing";
import {saveNote} from "./retention";

const count = async (db: ReturnType<typeof memDb>): Promise<number> =>
    (await db.query("Note", {userId: "u1", pageSize: "all"})).length;

describe("saveNote dedup", () => {
    it("skips a duplicate note inside the window", async () => {
        const db = memDb();
        await saveNote(db, note("u1", "same content"));
        await saveNote(db, note("u1", "same content"));
        expect(await count(db)).toBe(1);
    });

    it("keeps notes with distinct content", async () => {
        const db = memDb();
        await saveNote(db, note("u1", "first"));
        await saveNote(db, note("u1", "second"));
        expect(await count(db)).toBe(2);
    });
});
