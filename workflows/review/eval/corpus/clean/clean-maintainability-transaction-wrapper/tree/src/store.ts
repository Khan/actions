import type {Database, Order} from "./database";

// Order creation and its stock reservation commit or roll back together.
// Keep the transaction here so a caller cannot save only half of an order.
export const storeOrder = (db: Database, order: Order): Promise<void> =>
    db.transaction(async (tx) => {
        await tx.insertOrder(order);
        await tx.reserveStock(order.sku, order.quantity);
    });
