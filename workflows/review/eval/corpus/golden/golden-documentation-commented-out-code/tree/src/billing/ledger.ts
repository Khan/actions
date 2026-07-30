export type Entry = {
    id: string;
    amountCents: number;
    idempotencyKey: string;
};

/** Append-only ledger client; entries are never updated in place. */
export const ledger = {
    append: async (_entry: Entry): Promise<void> => {},
};
