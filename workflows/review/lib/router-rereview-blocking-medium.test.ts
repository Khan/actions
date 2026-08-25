import {describe, it, expect} from "vitest";

import {runCli} from "./router";
import {parseRoutingConfig, ROUTING_CONFIG_PATH} from "./routing-config";

/**
 * The `re-review <mode> blocking-medium` modifier's parse and CLI wiring, in
 * its own file per the one-directive-per-file convention
 * (router-dispatch-mode / router-non-blocking-budget precedent). The posting
 * surface the flag drives lives in submission-blocking-medium.test.ts. The
 * fs fixture is a small local copy of router.test.ts's.
 */

const fakeFs = (inputs: Record<string, string>) => {
    const written: Record<string, string> = {};
    const fs = {
        readFileSync: (p: string, _enc: "utf8"): string => {
            const content = inputs[p];
            if (content === undefined) {
                throw new Error(`unexpected read: ${p}`);
            }
            return content;
        },
        writeFileSync: (p: string, data: string): void => {
            written[p] = data;
        },
        existsSync: (p: string): boolean =>
            p in inputs ||
            Object.keys(inputs).some((key) => key.startsWith(`${p}/`)),
        mkdirSync: (_p: string, _opts: {recursive: boolean}): void => {},
        readdirSync: (p: string): string[] => {
            if (p in inputs) {
                throw new Error(`ENOTDIR: not a directory, scandir '${p}'`);
            }
            const prefix = p.endsWith("/") ? p : `${p}/`;
            const names = new Set<string>();
            for (const key of Object.keys(inputs)) {
                if (key.startsWith(prefix)) {
                    names.add(key.slice(prefix.length).split("/")[0]);
                }
            }
            return [...names];
        },
    };
    return {fs, written};
};

describe("parseRoutingConfig: the blocking-medium modifier", () => {
    it("parses the modifier on a reduced mode, warning-free", () => {
        const config = parseRoutingConfig("re-review scoped blocking-medium");
        expect(config.reReviewMode).toBe("scoped");
        expect(config.reReviewBlockingMedium).toBe(true);
        expect(config.reReviewBlockingOnly).toBe(false);
        expect(config.warnings).toEqual([]);
    });

    it("the winning duplicate line swaps one modifier for the other", () => {
        const config = parseRoutingConfig(
            "re-review scoped blocking-only\nre-review scoped blocking-medium",
        );
        expect(config.reReviewBlockingOnly).toBe(false);
        expect(config.reReviewBlockingMedium).toBe(true);
        expect(config.warnings.join("\n")).toContain("duplicate re-review");
    });

    it("warns that blocking-medium never applies at full depth", () => {
        const config = parseRoutingConfig("re-review full blocking-medium");
        expect(config.reReviewMode).toBe("full");
        expect(config.reReviewBlockingMedium).toBe(true);
        expect(config.warnings.join("\n")).toContain(
            "blocking-medium never applies at full re-review depth",
        );
    });
});

describe("runCli: the blocking-medium flag in routing.json", () => {
    it("surfaces the configured modifier", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
            [ROUTING_CONFIG_PATH]: "re-review scoped blocking-medium",
        });
        const json = runCli(fs);
        expect(json.reReviewBlockingMedium).toBe(true);
        expect(json.reReviewBlockingOnly).toBe(false);
    });
});
