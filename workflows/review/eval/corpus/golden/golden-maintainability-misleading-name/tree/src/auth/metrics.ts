import {isSessionValid, type Session} from "./session";

export const countValidSessions = (sessions: readonly Session[], now: number): number =>
    sessions.filter((session) => isSessionValid(session, now)).length;
