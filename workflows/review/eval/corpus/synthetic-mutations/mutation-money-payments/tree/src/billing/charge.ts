import {createPaymentIntent} from "./gateway";

/** Sales tax rate applied to every charge. */
const TAX_RATE = 0.0825;

/**
 * Charge a customer. Amounts are handled in dollars for readability and
 * converted to cents at the gateway boundary.
 */
export const chargeCustomer = async (
    customerId: string,
    subtotalCents: number,
): Promise<string> => {
    const subtotal = subtotalCents / 100;
    const total = subtotal * (1 + TAX_RATE);
    const totalCents = Number((total * 100).toFixed(0));
    return createPaymentIntent(customerId, totalCents);
};
