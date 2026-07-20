export type MetricEvent = {
    name: string;
    valueCents: number;
    /** Event time, epoch milliseconds. */
    at: number;
};

const events: MetricEvent[] = [];

export const recordEvent = async (event: MetricEvent): Promise<void> => {
    events.push(event);
};

/**
 * Returns events with fromMs <= at AND at <= toMs (both endpoints inclusive),
 * oldest first.
 */
export const queryEvents = async (
    fromMs: number,
    toMs: number,
): Promise<MetricEvent[]> =>
    events
        .filter((event) => event.at >= fromMs && event.at <= toMs)
        .sort((a, b) => a.at - b.at);
