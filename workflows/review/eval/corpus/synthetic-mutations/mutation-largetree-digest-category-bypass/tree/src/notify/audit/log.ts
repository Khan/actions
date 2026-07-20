import type {NotificationItem} from "../types";

export type AuditRecord = {
    kind: "delivery" | "drop" | "digest";
    userId: string;
    detail: string;
    at: number;
};

const records: AuditRecord[] = [];

export const recordDelivery = (item: NotificationItem): void => {
    records.push({
        kind: "delivery",
        userId: item.userId,
        detail: item.id,
        at: Date.now(),
    });
};

export const recordDrop = (item: NotificationItem, reason: string): void => {
    records.push({
        kind: "drop",
        userId: item.userId,
        detail: `${item.id}:${reason}`,
        at: Date.now(),
    });
};

export const recordDigest = (userId: string, itemCount: number): void => {
    records.push({
        kind: "digest",
        userId,
        detail: `items:${itemCount}`,
        at: Date.now(),
    });
};

export const auditTrail = (): readonly AuditRecord[] => records;
