import {signedMinorUnits} from "./money/decimal";

export const invoiceTotal = (amounts: readonly number[]): number => amounts.reduce((sum, amount) => sum + signedMinorUnits(amount), 0);
