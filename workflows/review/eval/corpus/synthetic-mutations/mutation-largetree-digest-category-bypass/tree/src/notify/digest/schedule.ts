import {sendBatch} from "../delivery/bulk";
import {recordDigest} from "../audit/log";
import {buildDigest} from "./assemble";
import {usersWithPending} from "./pending";

/** Runs Monday 09:00 platform time; invoked by the platform cron. */
export const runWeeklyDigests = async (): Promise<number> => {
    let sent = 0;
    for (const userId of usersWithPending()) {
        const digest = buildDigest(userId);
        if (digest === null) {
            continue;
        }
        await sendBatch(digest);
        recordDigest(digest.userId, digest.itemCount);
        sent += 1;
    }
    return sent;
};
