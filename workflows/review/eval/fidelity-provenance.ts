import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";

/** Production code used to build, validate, and render the measured claims. */
export const CLAIM_RENDERING_FILES = [
    "workflows/review/lib/dispatch-contracts.ts",
    "workflows/review/lib/submission-render.ts",
    "workflows/review/lib/render-comment.ts",
    "workflows/review/lib/attribution.ts",
    "workflows/review/lib/agent-json.ts",
    "workflows/review/lib/finding-schema.ts",
];

/** Hash paths and bytes together, in the recorded manifest order. */
export const hashFiles = (
    paths: readonly string[],
    read: (path: string) => Buffer = readFileSync,
): string => {
    const hash = createHash("sha256");
    for (const path of paths) {
        hash.update(path);
        hash.update(read(path));
    }
    return hash.digest("hex");
};
