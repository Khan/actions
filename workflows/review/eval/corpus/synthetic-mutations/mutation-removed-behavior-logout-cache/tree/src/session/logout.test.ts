import {forceLogout, logout, type Session} from "./logout";
import {isRevoked} from "./tokens";
import {auditLog} from "./audit";

const session: Session = {id: "s1", userId: "u1", deviceId: "d1"};

describe("session teardown", () => {
    it("logout revokes the session's tokens", async () => {
        await logout(session);
        expect(isRevoked("s1")).toBe(true);
    });

    it("forceLogout records its own audit reason", async () => {
        await forceLogout({...session, id: "s2"});
        expect(
            auditLog().some(
                (event) =>
                    event.type === "force-logout" && event.sessionId === "s2",
            ),
        ).toBe(true);
    });
});
