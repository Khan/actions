import type {NotificationItem} from "../types";

export const marketing = (item: NotificationItem): string =>
    [
        `<h2>From the team: ${item.subject}</h2>`,
        `<p>${item.body}</p>`,
    ].join("\n");
