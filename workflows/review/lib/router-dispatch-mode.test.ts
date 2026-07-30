import {describe, it, expect} from "vitest";

import {runCli} from "./router";
import {ROUTING_CONFIG_PATH} from "./routing-config";

/**
 * The retired `dispatch` directive's CLI wiring, split from router.test.ts
 * for its max-lines budget: `routing.json` always carries `scripted`, and a
 * leftover ROUTING line earns a visible obsolete warning rather than
 * changing behaviour.
 * The fs fixture is a small local copy of router.test.ts's, the same way
 * dispatch-gate-hardening.test.ts copies its parent's.
 */

const fakeFs = (inputs: Record<string, string>) => {
    const written: Record<string, string> = {};
    const mkdirCalls: string[] = [];
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
        mkdirSync: (p: string, _opts: {recursive: boolean}): void => {
            mkdirCalls.push(p);
        },
        readdirSync: (p: string): string[] => {
            if (p in inputs) {
                // Mirror node:fs — reading a regular file as a directory
                // throws ENOTDIR.
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
    return {fs, written, mkdirCalls};
};

describe("runCli: dispatch mode", () => {
    it("always emits scripted (the dial is retired), warning on a leftover line", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
            [ROUTING_CONFIG_PATH]: "dispatch scripted",
        });
        const routing = runCli(fs);
        expect(routing.dispatchMode).toBe("scripted");
        expect(routing.routingConfig.warnings.join(" ")).toContain("obsolete");
    });

    it("emits scripted without a dispatch line", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
        });
        expect(runCli(fs).dispatchMode).toBe("scripted");
    });
});
