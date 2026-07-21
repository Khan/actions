import type {NotificationItem} from "../types";

export const security = (item: NotificationItem): string =>
    [
        `<strong>Security notice: ${item.subject}</strong>`,
        `<p>${item.body}</p>`,
    ].join("\n");
