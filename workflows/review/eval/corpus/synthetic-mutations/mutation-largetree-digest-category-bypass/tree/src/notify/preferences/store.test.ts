import {isSubscribed, setFrequency, setSubscription, wantsDigest} from "./store";

describe("preferences store", () => {
    it("applies subscription defaults until a user opts in", () => {
        expect(isSubscribed("p1", "marketing")).toBe(false);
        expect(isSubscribed("p1", "billing")).toBe(true);
        setSubscription("p1", "marketing", true);
        expect(isSubscribed("p1", "marketing")).toBe(true);
    });

    it("digest opt-in follows frequency", () => {
        expect(wantsDigest("p2")).toBe(false);
        setFrequency("p2", "weekly");
        expect(wantsDigest("p2")).toBe(true);
    });
});
