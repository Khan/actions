const amountToMinor = (amount: number): number => Math.sign(amount) * Math.round(Math.abs(amount) * 100);
export const report = (amount: number): number => amountToMinor(amount);
