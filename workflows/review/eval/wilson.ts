/**
 * The binomial interval the eval's pooled rates carry (split out of
 * `aggregate.ts`, which re-exports these, when that module hit the file-size
 * lint, nothing here is specific to aggregation).
 */

export type RateStat = {
    numerator: number;
    denominator: number;
    rate: number;
    /** 95% Wilson score interval; [0,1] when the denominator is 0. */
    interval: {lo: number; hi: number};
};

/**
 * The Wilson score interval (95%, z=1.96): the standard binomial interval
 * that stays sane at the small n these runs live at (a 5/6 pass rate reads
 * 44-97%, not the Wald interval's overconfident nonsense).
 */
export const wilsonInterval = (
    successes: number,
    n: number,
): {lo: number; hi: number} => {
    if (n === 0) {
        return {lo: 0, hi: 1};
    }
    const z = 1.96;
    const p = successes / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
    return {lo: Math.max(0, center - half), hi: Math.min(1, center + half)};
};

export const rateStat = (numerator: number, denominator: number): RateStat => ({
    numerator,
    denominator,
    rate: denominator === 0 ? 0 : numerator / denominator,
    interval: wilsonInterval(numerator, denominator),
});
