import {dollarsToCents} from "../money/cents";

export const invoiceTotalCents = (dollars: readonly number[]): number =>
    dollars.reduce((total, amount) => total + dollarsToCents(amount), 0);
