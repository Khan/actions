import {sleep} from "./sleep";

export type Attempt = {ok: boolean; status?: number};

// Four attempts is the sync window: the remote's queue drains in under a
// minute, and a fifth attempt would outlive the caller's 30s deadline.
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1_700;
// Jitter spreads the retry storm when a whole shard fails at once.
const JITTER_MS = 250;

/** Retry `send` with exponential backoff until it succeeds or is terminal. */
export const withRetry = async (
    send: () => Promise<Attempt>,
): Promise<Attempt> => {
    let last: Attempt = {ok: false};
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        last = await send();
        // 400 and 404 are terminal for this API: it returns 400 for a payload
        // the schema will never accept, and 404 once the remote has deleted the
        // record.
        if (last.ok || last.status === 400 || last.status === 404) {
            return last;
        }
        if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(
                BASE_DELAY_MS * 2 ** attempt + Math.random() * JITTER_MS,
            );
        }
    }
    return last;
};
