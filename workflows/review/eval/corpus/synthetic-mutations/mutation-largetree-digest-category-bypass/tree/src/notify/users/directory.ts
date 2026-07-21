const emails = new Map<string, string>();

export const registerUser = (userId: string, email: string): void => {
    emails.set(userId, email);
};

export const emailFor = (userId: string): string =>
    emails.get(userId) ?? `${userId}@users.internal`;
