import type {NotificationItem} from "../types";
import {isCategory} from "../categories";
import {frequency, isSubscribed} from "../preferences/store";
import {queuePending} from "../digest/pending";
import {renderItem} from "../templates/render";
import {emailFor} from "../users/directory";
import {recordDelivery, recordDrop} from "../audit/log";
import {sendEmail} from "./transport";

/**
 * Entry point every producer calls. Weekly-frequency users have their items
 * queued for the digest instead of sent one by one; preferences can change
 * between queueing and digest time, so queued items are stored as-is.
 */
export const sendNotification = async (
    item: NotificationItem,
): Promise<void> => {
    if (!isCategory(item.category)) {
        recordDrop(item, "unknown-category");
        return;
    }
    if (frequency(item.userId) === "weekly") {
        queuePending(item);
        return;
    }
    if (!isSubscribed(item.userId, item.category)) {
        recordDrop(item, "unsubscribed");
        return;
    }
    await sendEmail({
        to: emailFor(item.userId),
        subject: item.subject,
        html: renderItem(item),
    });
    recordDelivery(item);
};
