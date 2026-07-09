import {describe, expect, it} from "vitest";

import {formatAmount, formatBytes} from "./format";

describe("formatAmount", () => {
    it("renders two decimals", () => {
        expect(formatAmount(3)).toBe("3.00");
        expect(formatAmount(3.456)).toBe("3.46");
    });
});

describe("formatBytes", () => {
    it("picks binary units", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(2048)).toBe("2.0 KiB");
    });
});
