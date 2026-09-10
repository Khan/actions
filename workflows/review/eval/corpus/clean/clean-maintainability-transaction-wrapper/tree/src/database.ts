export type Order = {id: string; sku: string; quantity: number};

export type Transaction = {
    insertOrder: (order: Order) => Promise<void>;
    reserveStock: (sku: string, quantity: number) => Promise<void>;
};

export type Database = {
    // Commits on success and rolls back both operations on failure.
    transaction: (work: (tx: Transaction) => Promise<void>) => Promise<void>;
};
