import type {NotificationItem} from "../types";

export const community = (item: NotificationItem): string =>
    [
        `<h3>Community: ${item.subject}</h3>`,
        `<p>${item.body}</p>`,
    ].join("\n");
