import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {runStagePrCli} from "./stage-pr";

const temporary: string[] = [];
afterEach(() => {
    for (const dir of temporary.splice(0)) {
        rmSync(dir, {recursive: true, force: true});
    }
});

const runtimeSource = (body: string): string =>
    `module.exports = { sanitizeContentCore(s) { ${body} }, sanitizeUrlProtocols(s) { return s; }, sanitizeUrlDomains(s) { return s; }, clearRedactedDomains() {} };`;

describe("stage-pr sanitizer preflight", () => {
    it.each([
        ["missing", undefined],
        ["module-load", "throw new Error('private module details')"],
        ["exports", "module.exports = {}"],
        [
            "invocation",
            runtimeSource("throw new Error('private body details')"),
        ],
        ["invocation", runtimeSource("return null")],
        ["invocation", runtimeSource("return 'wrong result'")],
    ])(
        "fails staging before fetching or writing on %s failure",
        async (category, source) => {
            const dir = mkdtempSync(join(tmpdir(), "stage-sanitizer-test-"));
            temporary.push(dir);
            if (source !== undefined) {
                mkdirSync(join(dir, "gh-aw/actions"), {recursive: true});
                writeFileSync(
                    join(dir, "gh-aw/actions/sanitize_content_core.cjs"),
                    source,
                );
            }
            vi.stubEnv("RUNNER_TEMP", dir);
            const fs = {
                readFileSync: vi.fn(() => ""),
                writeFileSync: vi.fn(),
                existsSync: vi.fn(() => false),
                mkdirSync: vi.fn(),
            };
            const ghGet = vi.fn(async () => {
                throw new Error("unexpected fetch");
            });
            const ghGraphql = vi.fn(async () => {
                throw new Error("unexpected graphql");
            });
            const ticketFetch = vi.fn(async () => {
                throw new Error("unexpected ticket fetch");
            });
            await expect(
                runStagePrCli(fs, ghGet, ghGraphql, ticketFetch, {
                    repo: "o/r",
                    prNumber: 7,
                    repoRoot: "/work",
                }),
            ).rejects.toMatchObject({
                name: "SanitizerUnavailableError",
                category,
                message: `The pinned gh-aw sanitizer is unavailable (${category}).`,
            });
            expect(ghGet).not.toHaveBeenCalled();
            expect(ghGraphql).not.toHaveBeenCalled();
            expect(ticketFetch).not.toHaveBeenCalled();
            for (const method of Object.values(fs)) {
                expect(method).not.toHaveBeenCalled();
            }
        },
    );
});
