import type {NotificationItem} from "../types";

export const tips = (item: NotificationItem): string =>
    [
        `<em>Tip: ${item.subject}</em>`,
        `<p>${item.body}</p>`,
    ].join("\n");
