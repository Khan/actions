import {describe, it, expect} from "vitest";

import {rateStat, wilsonInterval} from "./wilson";

describe("wilsonInterval", () => {
    it("brackets the point estimate and stays inside [0,1]", () => {
        const interval = wilsonInterval(5, 6);
        expect(interval.lo).toBeGreaterThan(0.4);
        expect(interval.lo).toBeLessThan(5 / 6);
        expect(interval.hi).toBeGreaterThan(5 / 6);
        expect(interval.hi).toBeLessThanOrEqual(1);
    });

    it("is exactly [0,1] at n=0 and never collapses at 0/n or n/n", () => {
        expect(wilsonInterval(0, 0)).toEqual({lo: 0, hi: 1});
        const zero = wilsonInterval(0, 10);
        expect(zero.lo).toBe(0);
        expect(zero.hi).toBeGreaterThan(0.2);
        const full = wilsonInterval(10, 10);
        expect(full.hi).toBe(1);
        expect(full.lo).toBeLessThan(1);
    });

    it("narrows as repeats accumulate (the whole point of pooling)", () => {
        const single = wilsonInterval(6, 8);
        const pooled = wilsonInterval(60, 80);
        expect(pooled.hi - pooled.lo).toBeLessThan((single.hi - single.lo) / 2);
    });
});

describe("rateStat", () => {
    it("carries numerator, denominator, rate, and interval together", () => {
        const stat = rateStat(3, 4);
        expect(stat.rate).toBe(0.75);
        expect(stat.interval.lo).toBeGreaterThan(0);
        expect(stat.interval.hi).toBeLessThanOrEqual(1);
        expect(rateStat(0, 0).rate).toBe(0);
    });
});
