import {formatReport, type ReportRow, type UsageEvent} from "./format-report";

/** Weekly usage summary a partner integration receives for its own features. */
export const buildPartnerReport = (
    events: UsageEvent[],
    partnerFeatures: string[],
): ReportRow[] => {
    const relevant = events.filter((event) =>
        partnerFeatures.includes(event.feature),
    );
    return formatReport(relevant);
};
