import {
    capturePayment,
    GatewayTimeoutError,
    type CaptureResult,
} from "./gateway";

const MAX_ATTEMPTS = 3;

/** Captures a charge, retrying when the gateway times out. */
export const captureWithRetry = async (
    chargeId: string,
    amountCents: number,
): Promise<CaptureResult> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
            return await capturePayment(chargeId, amountCents);
        } catch (error) {
            if (!(error instanceof GatewayTimeoutError)) {
                throw error;
            }
            lastError = error;
        }
    }
    throw lastError;
};
