import type {NotificationItem} from "../types";
import {productUpdates} from "./product-updates";
import {marketing} from "./marketing";
import {billing} from "./billing";
import {security} from "./security";
import {community} from "./community";
import {tips} from "./tips";

export type Template = (item: NotificationItem) => string;

const templates: Record<string, Template> = {
    product_updates: productUpdates,
    marketing,
    billing,
    security,
    community,
    tips,
};

const fallback: Template = (item) =>
    `<h2>${item.subject}</h2><p>${item.body}</p>`;

export const templateFor = (category: string): Template =>
    templates[category] ?? fallback;
