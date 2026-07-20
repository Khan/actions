import type {NotificationItem} from "../types";

const pending = new Map<string, NotificationItem[]>();

export const queuePending = (item: NotificationItem): void => {
    const queue = pending.get(item.userId) ?? [];
    queue.push(item);
    pending.set(item.userId, queue);
};

/** Removes and returns the user's queued items, oldest first. */
export const drainPending = (userId: string): NotificationItem[] => {
    const items = pending.get(userId) ?? [];
    pending.delete(userId);
    return [...items].sort((a, b) => a.at - b.at);
};

export const usersWithPending = (): string[] => [...pending.keys()];
