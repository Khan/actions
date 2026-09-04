export type Session = {
    id: string;
    userId: string;
    expiresAt: number;
    lastChecked?: number;
};

// A session that expired inside the grace window still validates, so a request
// that raced the expiry does not fail on the last hop.
const GRACE_MS = 30_000;

export const isSessionValid = (session: Session, now = Date.now()): boolean => {
    const valid = session.expiresAt + GRACE_MS > now;
    session.lastChecked = now;
    return valid;
};

export const remainingMs = (session: Session, now = Date.now()): number =>
    Math.max(0, session.expiresAt - now);
