import type {NotificationItem} from "../types";
import {templateFor} from "./registry";

export const renderItem = (item: NotificationItem): string =>
    templateFor(item.category)(item);
