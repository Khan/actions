import {captureWithRetry} from "./capture";
import * as gateway from "./gateway";

describe("captureWithRetry", () => {
    it("retries once after a gateway timeout", async () => {
        const calls: number[] = [];
        jest.spyOn(gateway, "capturePayment").mockImplementation(
            async (chargeId, amountCents) => {
                calls.push(amountCents);
                if (calls.length === 1) {
                    throw new gateway.GatewayTimeoutError();
                }
                return {chargeId, amountCents, capturedAt: 5};
            },
        );
        const result = await captureWithRetry("ch_1", 1250);
        expect(result.amountCents).toBe(1250);
        expect(calls).toHaveLength(2);
    });

    it("does not retry a declined charge", async () => {
        jest.spyOn(gateway, "capturePayment").mockRejectedValue(
            new Error("card_declined"),
        );
        await expect(captureWithRetry("ch_2", 500)).rejects.toThrow(
            "card_declined",
        );
    });
});
