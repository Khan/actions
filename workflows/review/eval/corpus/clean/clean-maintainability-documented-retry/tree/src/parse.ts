import type {ReviewResult} from "./types";

const parseReply = (text: string): ReviewResult => {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("findings" in value) ||
        !Array.isArray(value.findings) || !value.findings.every((item: unknown) => typeof item === "string")) {
        throw new Error("reply must contain a findings string array");
    }
    return {findings: value.findings};
};

// On a parse failure, call the model once more and stage its replacement output.
export const parseWithRetry = async (
    output: string,
    redispatch: () => Promise<string>,
): Promise<ReviewResult> => {
    try {
        return parseReply(output);
    } catch {
        return parseReply(await redispatch());
    }
};
