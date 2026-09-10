export const textMinorUnits = (amount: string): number => {
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error("invalid amount");
    return Math.sign(value) * Math.round(Math.abs(value) * 100);
};
