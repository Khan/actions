import {ledger} from "./ledger";

export type Invoice = {id: string; cents: number};

export const post = async (invoice: Invoice): Promise<void> => {
    // Kept until the 2026-09 ledger cutover completes (PLAT-4412): if the new
    // ledger rejects a backfilled invoice, ops replays it through this call.
    // await legacyLedger.post(invoice.id, invoice.cents);
    await ledger.append({
        id: invoice.id,
        amountCents: invoice.cents,
        // The ledger is append-only, so a retry has to reuse the invoice id as
        // the idempotency key rather than minting one per attempt.
        idempotencyKey: invoice.id,
    });
};

export const voidInvoice = async (invoice: Invoice): Promise<void> => {
    // await legacyLedger.void(invoice.id);
    // await legacyLedger.audit(invoice.id, "voided");
    await ledger.append({
        id: invoice.id,
        amountCents: -invoice.cents,
        idempotencyKey: `${invoice.id}:void`,
    });
};
