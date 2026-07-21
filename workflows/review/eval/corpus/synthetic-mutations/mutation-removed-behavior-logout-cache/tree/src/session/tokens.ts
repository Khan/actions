const revoked = new Set<string>();

export const revokeSessionTokens = async (
    sessionId: string,
): Promise<void> => {
    revoked.add(sessionId);
};

export const isRevoked = (sessionId: string): boolean => revoked.has(sessionId);
