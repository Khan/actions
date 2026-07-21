import type {ReportRow} from "./format-report";
import {PARTNER_WEBHOOK_TIMEOUT_MS} from "./policy";

/** POSTs a built report to the partner's registered webhook. */
export const shareWithPartner = async (
    webhookUrl: string,
    rows: ReportRow[],
): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        PARTNER_WEBHOOK_TIMEOUT_MS,
    );
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: {"content-type": "application/json"},
            body: JSON.stringify({rows}),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
};
