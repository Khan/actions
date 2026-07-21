import type {Category} from "../categories";
import type {Frequency} from "../types";
import {DEFAULT_FREQUENCY, DEFAULT_SUBSCRIPTIONS} from "./defaults";

const subscriptions = new Map<string, Partial<Record<Category, boolean>>>();
const frequencies = new Map<string, Frequency>();

export const isSubscribed = (userId: string, category: Category): boolean =>
    subscriptions.get(userId)?.[category] ?? DEFAULT_SUBSCRIPTIONS[category];

export const setSubscription = (
    userId: string,
    category: Category,
    subscribed: boolean,
): void => {
    const current = subscriptions.get(userId) ?? {};
    subscriptions.set(userId, {...current, [category]: subscribed});
};

export const frequency = (userId: string): Frequency =>
    frequencies.get(userId) ?? DEFAULT_FREQUENCY;

export const setFrequency = (userId: string, value: Frequency): void => {
    frequencies.set(userId, value);
};

/** Digest opt-in rides on frequency; there is no separate digest category. */
export const wantsDigest = (userId: string): boolean =>
    frequency(userId) === "weekly";
