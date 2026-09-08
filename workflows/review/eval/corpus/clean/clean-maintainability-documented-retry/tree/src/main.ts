import {parseWithRetry} from "./parse";
import {runReview} from "./review";

export const review = (
    callModel: (instruction: string) => Promise<string>,
    stage: (output: string) => void,
) => {
    const dispatch = async (instruction: string): Promise<string> => {
        const output = await callModel(instruction);
        stage(output);
        return output;
    };
    return runReview({
        dispatch: () => dispatch("Return a JSON object with a findings string array."),
        parse: (output) => parseWithRetry(output, () =>
            dispatch("The reply was malformed. Return a JSON object with a findings string array.")),
    });
};
