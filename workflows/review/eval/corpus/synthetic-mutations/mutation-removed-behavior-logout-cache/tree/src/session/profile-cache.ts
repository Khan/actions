/**
 * Per-device profile cache. Entries are keyed by DEVICE id, not user id: a
 * device that logs a different user in reuses the same key. Whoever ends a
 * session MUST drop the device's entry, or the next login on that device is
 * served the previous user's profile until the entry expires (24h).
 */
export type Profile = {
    userId: string;
    displayName: string;
    email: string;
};

const entries = new Map<string, Profile>();

export const profileCache = {
    get: (deviceId: string): Profile | undefined => entries.get(deviceId),
    set: (deviceId: string, profile: Profile): void => {
        entries.set(deviceId, profile);
    },
    drop: (deviceId: string): void => {
        entries.delete(deviceId);
    },
};
