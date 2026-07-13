import {sql} from "../db";

export type Order = {
    id: string;
    customerId: string;
    createdAt: string;
    status: string;
};

/** The picker dashboard's work queue: pending orders, newest first. */
export const listOrders = async (limit: number): Promise<Order[]> => {
    return sql`
        SELECT id, customer_id, created_at, status
        FROM orders
        WHERE status = 'pending'
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
};
