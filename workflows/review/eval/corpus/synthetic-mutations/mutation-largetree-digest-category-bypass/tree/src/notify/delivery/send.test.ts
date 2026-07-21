import {sendNotification} from "./send";
import {sentEmails} from "./transport";
import {setSubscription} from "../preferences/store";

const item = (userId: string, id: string, category: string) => ({
    id,
    userId,
    category,
    subject: `s-${id}`,
    body: `b-${id}`,
    at: 1,
});

describe("sendNotification", () => {
    it("sends subscribed categories immediately", async () => {
        const before = sentEmails().length;
        await sendNotification(item("s1", "i1", "billing"));
        expect(sentEmails().length).toBe(before + 1);
    });

    it("drops unsubscribed categories", async () => {
        setSubscription("s2", "community", false);
        const before = sentEmails().length;
        await sendNotification(item("s2", "i2", "community"));
        expect(sentEmails().length).toBe(before);
    });
});
