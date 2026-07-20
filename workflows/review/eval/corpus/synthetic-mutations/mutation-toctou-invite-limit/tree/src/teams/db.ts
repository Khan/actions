export type Member = {
    teamId: string;
    email: string;
    role: "member" | "owner";
    invitedAt: number;
};

const members: Member[] = [];
const locks = new Map<string, Promise<unknown>>();

export const countMembers = async (teamId: string): Promise<number> =>
    members.filter((member) => member.teamId === teamId).length;

export const insertMember = async (member: Member): Promise<void> => {
    members.push(member);
};

/**
 * Runs `fn` while holding the team's write lock; writers for the same team
 * are serialized in arrival order.
 */
export const withTeamLock = async <T>(
    teamId: string,
    fn: () => Promise<T>,
): Promise<T> => {
    const previous = locks.get(teamId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(teamId, next);
    return next as Promise<T>;
};
