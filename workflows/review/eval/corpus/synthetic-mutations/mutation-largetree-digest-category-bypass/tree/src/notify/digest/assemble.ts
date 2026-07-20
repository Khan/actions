import {wantsDigest} from "../preferences/store";
import {renderDigest} from "../templates/digest";
import {drainPending} from "./pending";

export type Digest = {
    userId: string;
    subject: string;
    html: string;
    itemCount: number;
};

/**
 * Builds the weekly digest for one user, or null when there is nothing to
 * send this week.
 */
export const buildDigest = (userId: string): Digest | null => {
    if (!wantsDigest(userId)) {
        return null;
    }
    const items = drainPending(userId);
    if (items.length === 0) {
        return null;
    }
    return {
        userId,
        subject: `Your weekly digest (${items.length} updates)`,
        html: renderDigest(items),
        itemCount: items.length,
    };
};
