import type {Database, Order} from "./database";
import {storeOrder} from "./store";

export const placeOrder = async (db: Database, order: Order): Promise<{id: string}> => {
    await storeOrder(db, order);
    return {id: order.id};
};
