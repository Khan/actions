export const checkedMinorUnits = (amount: number): number => {
    if (!Number.isFinite(amount)) throw new Error("finite amount required");
    return Math.sign(amount) * Math.round(Math.abs(amount) * 100);
};
