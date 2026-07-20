import type {NotificationItem} from "../types";

export const productUpdates = (item: NotificationItem): string =>
    [
        `<h2>What's new: ${item.subject}</h2>`,
        `<p>${item.body}</p>`,
    ].join("\n");
