export type Profile = {
    userId: string;
    displayName: string;
    locale: string;
};

const profiles = new Map<string, Profile>();

export const profileFor = (userId: string): Profile =>
    profiles.get(userId) ?? {
        userId,
        displayName: userId,
        locale: "en-US",
    };

export const saveProfile = (profile: Profile): void => {
    profiles.set(profile.userId, profile);
};
