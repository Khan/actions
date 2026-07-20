import type {Category} from "../categories";

/**
 * Subscription defaults for users who never touched their settings.
 * Marketing and tips are opt-in; everything else is opt-out.
 */
export const DEFAULT_SUBSCRIPTIONS: Record<Category, boolean> = {
    product_updates: true,
    marketing: false,
    billing: true,
    security: true,
    community: true,
    tips: false,
};

/** Digest delivery is opt-in; users start on immediate sends. */
export const DEFAULT_FREQUENCY = "immediate";
