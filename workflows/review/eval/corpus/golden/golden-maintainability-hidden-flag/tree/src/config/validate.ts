import type {Config} from "./types";

const KNOWN = new Set(["name", "port", "logLevel"]);

export const validateKeys = (raw: unknown, strict: boolean): Config => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("config must be an object");
    }
    for (const key of Object.keys(raw)) {
        if (!KNOWN.has(key)) {
            if (strict) {
                throw new Error(`config: unknown key "${key}"`);
            }
            console.warn(`config: unknown key "${key}" ignored`);
        }
    }
    return raw as Config;
};
