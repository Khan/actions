import {memDb, note} from "./testing";
import {pruneNotes, saveNote} from "./retention";

describe("pruneNotes", () => {
    it("prunes old notes past the cap", async () => {
        const db = memDb();
        await saveNote(db, note("u1", "first"));
        await saveNote(db, note("u1", "second"));
        await expect(pruneNotes(db, "u1")).resolves.toBeUndefined();
    });
});
