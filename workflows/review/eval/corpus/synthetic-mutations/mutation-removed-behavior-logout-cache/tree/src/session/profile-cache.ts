/** Per-device profile cache; entries expire 24h after they are set. */
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
