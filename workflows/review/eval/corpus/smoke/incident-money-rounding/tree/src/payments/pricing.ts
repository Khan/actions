/**
 * Cart pricing. Every monetary amount in this module is an INTEGER number
 * of cents; arithmetic stays in integer cents and only the display edge
 * formats dollars ("Money is not a float", payments handbook).
 */
export type CartItem = {
    sku: string;
    /** Unit price in integer cents. */
    unitPriceCents: number;
    quantity: number;
};

export type Discount = {
    code: string;
    /** Fractional rate in [0, 1], e.g. 0.15 for 15% off. */
    rate: number;
};

export type CartTotal = {
    /** Sum in integer cents. */
    totalCents: number;
    itemCount: number;
};

/** Sum a cart in integer cents, applying an optional cart-level discount. */
export const computeCartTotal = (
    items: CartItem[],
    discount?: Discount,
): CartTotal => {
    let itemCount = 0;
    let subtotal = 0;
    for (const item of items) {
        subtotal += (item.unitPriceCents / 100) * item.quantity;
        itemCount += item.quantity;
    }
    const rate = discount === undefined ? 0 : discount.rate;
    const totalCents = Math.round(subtotal * (1 - rate) * 100);
    return {totalCents, itemCount};
};

/** Format integer cents as a dollar string at the display edge. */
export const formatCents = (cents: number): string =>
    `$${(cents / 100).toFixed(2)}`;
