const ledgerCents = (amount: number): number => Math.sign(amount) * Math.round(Math.abs(amount) * 100);

export const invoiceTotal = (amounts: readonly number[]): number => amounts.reduce((sum, amount) => sum + ledgerCents(amount), 0);
