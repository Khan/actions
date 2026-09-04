import {SenderRegistry} from "./sender";
import type {Activity} from "./types";

const registry = new SenderRegistry();

// Digests group by day so a busy week reads as seven lines, not seventy.
const groupByDay = (items: readonly Activity[]): Map<string, Activity[]> => {
    const days = new Map<string, Activity[]>();
    for (const item of items) {
        const day = item.at.slice(0, 10);
        days.set(day, [...(days.get(day) ?? []), item]);
    }
    return days;
};

export const sendDigest = async (to: string, items: readonly Activity[]): Promise<void> => {
    if (items.length === 0) {
        return;
    }
    const lines: string[] = [];
    for (const [day, dayItems] of groupByDay(items)) {
        lines.push(`${day}: ${dayItems.length} update${dayItems.length === 1 ? "" : "s"}`);
    }
    await registry.get("email").send({
        to,
        subject: `${items.length} updates`,
        body: lines.join("\n"),
    });
};
