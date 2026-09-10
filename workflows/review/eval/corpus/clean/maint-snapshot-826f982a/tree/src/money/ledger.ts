export const entries: number[] = [];
export const postedMinorUnits = (amount: number): number => {
    const cents = Math.sign(amount) * Math.round(Math.abs(amount) * 100);
    entries.push(cents);
    return cents;
};
