import {revokeSessionTokens} from "./tokens";
import {recordAudit} from "./audit";

export type Session = {
    id: string;
    userId: string;
    deviceId: string;
};

/** Shared teardown for user logout and admin force-logout. */
const endSession = async (session: Session, reason: string): Promise<void> => {
    await revokeSessionTokens(session.id);
    recordAudit({type: reason, sessionId: session.id, at: Date.now()});
};

export const logout = async (session: Session): Promise<void> => {
    await endSession(session, "logout");
};

export const forceLogout = async (session: Session): Promise<void> => {
    await endSession(session, "force-logout");
};
