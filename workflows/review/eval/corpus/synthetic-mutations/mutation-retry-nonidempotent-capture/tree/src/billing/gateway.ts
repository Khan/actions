export type CaptureResult = {
    chargeId: string;
    amountCents: number;
    capturedAt: number;
};

export class GatewayTimeoutError extends Error {
    constructor() {
        super("payment gateway did not respond within 10s");
    }
}

export type CaptureOptions = {
    /**
     * Requests carrying the same key are applied at most once, however many
     * times they are sent. Keys are scoped to the merchant account and kept
     * for 30 days.
     */
    idempotencyKey?: string;
};

/**
 * Captures a previously authorized charge. Throws GatewayTimeoutError when no
 * response arrives within 10s. Network call into the payments platform.
 */
export const capturePayment = async (
    chargeId: string,
    amountCents: number,
    options: CaptureOptions = {},
): Promise<CaptureResult> => {
    void chargeId;
    void amountCents;
    void options;
    throw new Error("stubbed in tests");
};
