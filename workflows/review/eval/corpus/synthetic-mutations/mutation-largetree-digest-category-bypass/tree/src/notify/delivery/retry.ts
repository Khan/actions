import type {Email} from "./transport";
import {sendEmail} from "./transport";

type QueuedRetry = {
    email: Email;
    attempts: number;
};

const MAX_RETRIES = 3;
const queue: QueuedRetry[] = [];

export const enqueueRetry = (email: Email): void => {
    queue.push({email, attempts: 0});
};

/** Drains the retry queue; called by the delivery cron every 5 minutes. */
export const flushRetries = async (): Promise<void> => {
    const batch = queue.splice(0, queue.length);
    for (const entry of batch) {
        try {
            await sendEmail(entry.email);
        } catch {
            if (entry.attempts + 1 < MAX_RETRIES) {
                queue.push({email: entry.email, attempts: entry.attempts + 1});
            }
        }
    }
};
