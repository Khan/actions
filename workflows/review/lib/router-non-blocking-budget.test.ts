import {describe, it, expect} from "vitest";

import {runCli} from "./router";
import {parseRoutingConfig, ROUTING_CONFIG_PATH} from "./routing-config";

/**
 * The `non-blocking-budget <n>` directive's parse and CLI wiring, split from
 * router.test.ts for its max-lines budget (the router-rereview-blocking-only
 * precedent). The posting-surface behavior the number drives lives in
 * submission-trial-followups.test.ts; here we pin only that the ROUTING line
 * parses and that `routing.json` carries the value to the submission CLI.
 * The fs fixture is a small local copy of router.test.ts's.
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

describe("parseRoutingConfig: non-blocking-budget directive", () => {
    it("defaults to 3", () => {
        expect(
            parseRoutingConfig("docs/** tier=trivial").nonBlockingInlineBudget,
        ).toBe(3);
    });

    it("parses a non-negative integer, zero included", () => {
        expect(
            parseRoutingConfig("non-blocking-budget 5").nonBlockingInlineBudget,
        ).toBe(5);
        expect(
            parseRoutingConfig("non-blocking-budget 0").nonBlockingInlineBudget,
        ).toBe(0);
    });

    it("warns on a malformed value and keeps the default", () => {
        for (const value of ["three", "-1", "2.5"]) {
            const config = parseRoutingConfig(`non-blocking-budget ${value}`);
            expect(config.nonBlockingInlineBudget).toBe(3);
            expect(config.warnings.join("\n")).toContain(
                "non-negative integer",
            );
        }
    });

    it("skips a line with the wrong arity", () => {
        const config = parseRoutingConfig("non-blocking-budget 2 4");
        expect(config.nonBlockingInlineBudget).toBe(3);
        expect(config.warnings.join("\n")).toContain("exactly one number");
    });

    it("lets the last of duplicate lines win, with a warning", () => {
        const config = parseRoutingConfig(
            "non-blocking-budget 5\nnon-blocking-budget 2",
        );
        expect(config.nonBlockingInlineBudget).toBe(2);
        expect(config.warnings.join("\n")).toContain(
            "duplicate non-blocking-budget",
        );
    });
});

describe("runCli: non-blocking budget", () => {
    it("surfaces the configured budget in routing.json", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
            [ROUTING_CONFIG_PATH]: "non-blocking-budget 1",
        });
        expect(runCli(fs).nonBlockingInlineBudget).toBe(1);
    });

    it("defaults to 3 without a ROUTING config", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
        });
        expect(runCli(fs).nonBlockingInlineBudget).toBe(3);
    });
});
