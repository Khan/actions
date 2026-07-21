import type {NotificationItem} from "../types";

export const billing = (item: NotificationItem): string =>
    [
        `<strong>Billing update: ${item.subject}</strong>`,
        `<p>${item.body}</p>`,
    ].join("\n");
