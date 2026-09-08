export const signedMinorUnits = (amount: number): number => Math.sign(amount) * Math.round(Math.abs(amount) * 100);
