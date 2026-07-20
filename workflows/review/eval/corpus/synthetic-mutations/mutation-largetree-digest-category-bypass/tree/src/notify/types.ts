export type NotificationItem = {
    id: string;
    userId: string;
    /** One of the ids in categories.ts. */
    category: string;
    subject: string;
    body: string;
    /** Creation time, epoch milliseconds. */
    at: number;
};

export type Frequency = "immediate" | "weekly";
