export type LineItem = {
    id: string;
    category: string;
    /** Integer cents, when the source already normalized the amount. */
    cents?: number;
    /** Float dollars, for imported items that were not normalized. */
    dollars?: number;
};
