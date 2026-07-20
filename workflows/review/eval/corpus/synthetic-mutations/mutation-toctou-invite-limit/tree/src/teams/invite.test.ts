import {inviteMember, SeatLimitError} from "./invite";

describe("inviteMember", () => {
    it("adds members below the seat limit", async () => {
        await inviteMember("t1", "a@example.com", 2);
        await inviteMember("t1", "b@example.com", 2);
    });

    it("rejects an invite past the seat limit", async () => {
        await expect(
            inviteMember("t1", "c@example.com", 2),
        ).rejects.toThrow(SeatLimitError);
    });
});
