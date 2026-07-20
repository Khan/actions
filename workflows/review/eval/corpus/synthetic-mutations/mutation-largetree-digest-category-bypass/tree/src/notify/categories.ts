/** Notification categories users can subscribe to individually. */
export const CATEGORIES = [
    "product_updates",
    "marketing",
    "billing",
    "security",
    "community",
    "tips",
] as const;

export type Category = typeof CATEGORIES[number];

export const isCategory = (value: string): value is Category =>
    (CATEGORIES as readonly string[]).includes(value);
