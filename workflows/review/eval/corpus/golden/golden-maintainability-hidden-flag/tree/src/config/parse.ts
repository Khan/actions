import {validateKeys} from "./validate";
import type {Config} from "./types";

export const parseConfig = (text: string, strict: boolean): Config => {
    const raw: unknown = JSON.parse(text);
    return validateKeys(raw, strict);
};
