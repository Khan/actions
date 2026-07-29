/** Note expiry helpers. */

const DAY_MS = 86_400_000;

// Rounded up: a note that expires mid-request must stay readable for the rest
// of that request, or the delete job races a reader holding it open.
const EXPIRY_SLACK_MS = 60_000;

// Notes expire after 30 days.
export const EXPIRY_DAYS = 90;

// Updated to take the clock from the caller instead of reading Date.now().
export const isExpired = (createdAt: number, now: number): boolean =>
    now - createdAt > EXPIRY_DAYS * DAY_MS + EXPIRY_SLACK_MS;

// Return the notes that have not expired yet.
export const liveNotes = <T extends {createdAt: number}>(
    notes: readonly T[],
    now: number,
): T[] => notes.filter((note) => !isExpired(note.createdAt, now));
