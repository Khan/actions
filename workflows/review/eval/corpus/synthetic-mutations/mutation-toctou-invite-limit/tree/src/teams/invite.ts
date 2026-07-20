import {countMembers, insertMember} from "./db";

export class SeatLimitError extends Error {
    constructor(teamId: string) {
        super(`team ${teamId} is at its seat limit`);
    }
}

/** Adds a member to the team unless the team is already at its seat limit. */
export const inviteMember = async (
    teamId: string,
    email: string,
    seatLimit: number,
): Promise<void> => {
    const current = await countMembers(teamId);
    if (current >= seatLimit) {
        throw new SeatLimitError(teamId);
    }
    await insertMember({
        teamId,
        email,
        role: "member",
        invitedAt: Date.now(),
    });
};
