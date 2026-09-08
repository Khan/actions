import type {ReviewResult} from "./types";

export type ReviewIo = {
    dispatch: () => Promise<string>;
    // Parsing may dispatch once more on malformed output and replace the staged reply.
    // The returned promise includes that paid retry, not just local decoding.
    parse: (output: string) => Promise<ReviewResult>;
};

export const runReview = async (io: ReviewIo): Promise<ReviewResult> => {
    const output = await io.dispatch();
    // Allow one corrective model call if this reply does not satisfy the contract.
    return io.parse(output);
};
