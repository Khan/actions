import {createHash} from "node:crypto";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {runDispatchGateCli, BLOCKED_SENTINEL_PATH} from "./dispatch-gate";
import {
    createBodyNormalization,
    verifyRunnerSanitizer,
} from "./sanitizer-normalize";
import {
    loadRunnerSanitizer,
    SanitizerUnavailableError,
} from "./sanitizer-runtime";

const fixture = fileURLToPath(
    new URL("../test-fixtures/sanitizer/", import.meta.url),
);
const temporary: string[] = [];
afterEach(() => {
    for (const dir of temporary.splice(0)) {
        rmSync(dir, {recursive: true, force: true});
    }
});
const brokenRuntime = (source: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "sanitizer-test-"));
    temporary.push(dir);
    mkdirSync(join(dir, "gh-aw/actions"), {recursive: true});
    writeFileSync(join(dir, "gh-aw/actions/sanitize_content_core.cjs"), source);
    return dir;
};

describe("the pinned sanitizer runtime", () => {
    it("keeps offline fixtures byte-identical to their recorded hashes", () => {
        const manifest = JSON.parse(
            readFileSync(join(fixture, "manifest.json"), "utf8"),
        ) as {
            commit: string;
            files: Record<string, string>;
        };
        expect(manifest.commit).toBe(
            "2709137ea6c5b0e19aa621454dc643ea8dc526b1",
        );
        expect(Object.keys(manifest.files)).toHaveLength(6);
        for (const [file, hash] of Object.entries(manifest.files)) {
            expect(
                createHash("sha256")
                    .update(readFileSync(join(fixture, file)))
                    .digest("hex"),
            ).toBe(hash);
        }
    });

    it("loads upstream functions without installing globals or logging review text", () => {
        const globals = {...global} as Record<string, unknown>;
        const stdout = vi.spyOn(process.stdout, "write");
        const runtime = loadRunnerSanitizer();
        expect(runtime.sanitizeContentCore("`<repo>` <repo>")).toBe(
            "`<repo>` (repo)",
        );
        const pair = createBodyNormalization(runtime);
        expect(pair.planned("https://example.com/private")).toBe(
            pair.queued("(example.com/redacted)"),
        );
        expect((global as Record<string, unknown>).core).toBe(globals.core);
        expect(stdout).not.toHaveBeenCalled();
        stdout.mockRestore();
    });

    it("provides the URL global used to derive enterprise GitHub domains", () => {
        vi.stubEnv("GITHUB_SERVER_URL", "https://github.enterprise.example");
        expect(
            loadRunnerSanitizer().sanitizeContentCore(
                "https://github.enterprise.example/repo",
            ),
        ).toBe("https://github.enterprise.example/repo");
    });

    it("does not fall back to the checkout or test fixtures when RUNNER_TEMP is absent", () => {
        vi.stubEnv("RUNNER_TEMP", undefined);
        expect(() => loadRunnerSanitizer()).toThrow(SanitizerUnavailableError);
        expect(() => loadRunnerSanitizer()).toThrow(
            "The pinned gh-aw sanitizer is unavailable (config).",
        );
        expect(() => loadRunnerSanitizer(".")).toThrow(
            "The pinned gh-aw sanitizer is unavailable (config).",
        );
        expect(() => loadRunnerSanitizer(join(fixture, "missing"))).toThrow(
            "The pinned gh-aw sanitizer is unavailable (missing).",
        );
    });

    it.each([
        ["module-load", "throw new Error('private module failure')"],
        ["module-load", "require('./missing-private-dependency.cjs')"],
        ["exports", "module.exports = {}"],
        ["exports", "module.exports = null"],
        [
            "exports",
            "module.exports = { get sanitizeContentCore() { throw new Error('private export failure'); } }",
        ],
    ])(
        "reports only the bounded %s category for broken modules",
        (category, source) => {
            expect(() => loadRunnerSanitizer(brokenRuntime(source))).toThrow(
                `The pinned gh-aw sanitizer is unavailable (${category}).`,
            );
        },
    );

    it("checks the production loader and invocation path without emitting text", () => {
        const stdout = vi.spyOn(process.stdout, "write");
        const stderr = vi.spyOn(process.stderr, "write");
        try {
            expect(() => verifyRunnerSanitizer()).not.toThrow();
            expect(stdout).not.toHaveBeenCalled();
            expect(stderr).not.toHaveBeenCalled();
        } finally {
            stdout.mockRestore();
            stderr.mockRestore();
        }
    });

    it.each([
        "sanitizeContentCore",
        "sanitizeUrlProtocols",
        "sanitizeUrlDomains",
        "clearRedactedDomains",
    ])("preflight exercises %s and suppresses invocation details", (method) => {
        vi.stubEnv(
            "RUNNER_TEMP",
            brokenRuntime(
                `module.exports = { sanitizeContentCore(s) { return s; }, sanitizeUrlProtocols(s) { return s; }, sanitizeUrlDomains(s) { return s; }, clearRedactedDomains() {} }; module.exports.${method} = () => { throw new Error('private invocation details'); };`,
            ),
        );
        expect(() => verifyRunnerSanitizer()).toThrow(
            "The pinned gh-aw sanitizer is unavailable (invocation).",
        );
    });

    it.each(["load", "call"])(
        "strips posting outputs on %s failure even after a successful preflight",
        (failure) => {
            verifyRunnerSanitizer();
            const runtimeDir = brokenRuntime(
                failure === "load"
                    ? "module.exports = {}"
                    : "module.exports = { sanitizeContentCore() { throw new Error('private invocation failure'); }, sanitizeUrlProtocols(s) { return s; }, sanitizeUrlDomains(s) { return s; }, clearRedactedDomains() {} };",
            );
            vi.stubEnv("RUNNER_TEMP", runtimeDir);
            const items = [
                {
                    type: "submit_pull_request_review",
                    event: "COMMENT",
                    body: "Commented.",
                },
                {
                    type: "resolve_pull_request_review_thread",
                    thread_id: "thread-1",
                },
                {type: "upload_artifact", path: "out"},
            ];
            const files: Record<string, string> = {
                "/tmp/gh-aw/agent_output.json": JSON.stringify({items}),
                "/tmp/gh-aw/review/submission-plan.json": JSON.stringify({
                    event: "COMMENT",
                    body: "Commented.",
                    comments: [],
                }),
            };
            const report = runDispatchGateCli({
                readFileSync: (p) => files[p],
                writeFileSync: (p, data) => {
                    files[p] = data;
                },
                existsSync: (p) => p in files,
                mkdirSync: () => {},
                readdirSync: () => [],
            });
            expect(report.blocked).toBe(true);
            expect(report.violations).toContainEqual(
                expect.objectContaining({dimension: "sanitizer unavailable"}),
            );
            expect(files[BLOCKED_SENTINEL_PATH]).toBe("blocked\n");
            expect(
                JSON.parse(files["/tmp/gh-aw/agent_output.json"]).items,
            ).toEqual([items[2]]);
            expect(JSON.stringify(report)).not.toContain("private");
            expect(report.violations).toContainEqual(
                expect.objectContaining({
                    detail: `The pinned gh-aw sanitizer is unavailable (${
                        failure === "load" ? "exports" : "invocation"
                    }).`,
                }),
            );
        },
    );
});
