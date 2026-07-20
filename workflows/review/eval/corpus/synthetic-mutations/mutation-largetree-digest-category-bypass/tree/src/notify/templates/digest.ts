import type {NotificationItem} from "../types";
import {wrapHtml} from "./layout";
import {renderItem} from "./render";

/** One section per queued item, oldest first, inside the standard shell. */
export const renderDigest = (items: NotificationItem[]): string =>
    wrapHtml(
        [
            `<h1>Your week in review</h1>`,
            ...items.map((item) => `<section>${renderItem(item)}</section>`),
        ].join("\n"),
    );
