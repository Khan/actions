export type Failure = {kind: "network" | "quota" | "permanent"; retryable: boolean};
export const retryDelay = (failure: Failure): number | null => {
    if (!failure.retryable) return null;
    if (failure.kind === "permanent") return null;
    if (failure.kind === "quota") return 60;
    if (!failure.retryable) return 0;
    return 5;
};
