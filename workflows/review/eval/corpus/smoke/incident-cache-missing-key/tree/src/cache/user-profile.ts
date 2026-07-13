import {cacheGet, cacheSet} from "./client";
import {fetchProfileFromDb, type UserProfile} from "../models/profile";

const TTL_SECONDS = 300;

/** Canonical cache key for a profile entry. */
const profileKey = (userId: string): string => `user-profile:${userId}`;

/** Cached read of a user's profile. */
export const getUserProfile = async (
    tenantId: string,
    userId: string,
): Promise<UserProfile> => {
    const key = profileKey(userId);
    const cached = await cacheGet<UserProfile>(key);
    if (cached !== null) {
        return cached;
    }
    const profile = await fetchProfileFromDb(tenantId, userId);
    await cacheSet(key, profile, TTL_SECONDS);
    return profile;
};
