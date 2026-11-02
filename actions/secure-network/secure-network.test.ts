import {describe, it, expect, vi} from "vitest";
import {createRequire} from "module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

const {
    parseArgs,
    validateDomain,
    parseNameservers,
    parseSearchDomains,
    parseGithubActionsDomains,
    buildAllowlistLines,
    buildUnboundConf,
    loadAllowlistFile,
    stripWildcard,
    mapWithConcurrency,
    fetchWithRetry,
} = require("./secure-network.js");

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
    it("should return empty conf files and domains for empty input", () => {
        // Arrange
        const argv: string[] = [];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result).toEqual({confFiles: [], domains: []});
    });

    it("should parse --conf-files with a single path", () => {
        // Arrange
        const argv = ["--conf-files=path/to/foo.conf"];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual(["path/to/foo.conf"]);
    });

    it("should parse --conf-files with multiple comma-separated paths", () => {
        // Arrange
        const argv = [
            "--conf-files=path/to/foo.conf,path/to/bar.conf,path/to/baz.conf",
        ];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual([
            "path/to/foo.conf",
            "path/to/bar.conf",
            "path/to/baz.conf",
        ]);
    });

    it("should filter empty entries from --conf-files (blank lines from conditional expressions)", () => {
        // Arrange
        const argv = ["--conf-files=,foo.conf,,bar.conf,"];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual(["foo.conf", "bar.conf"]);
    });

    it("should collect positional args as domains", () => {
        // Arrange
        const argv = ["github.com", "example.com"];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.domains).toEqual(["github.com", "example.com"]);
    });

    it("should separate --conf-files flag and positional args", () => {
        // Arrange
        const argv = [
            "--conf-files=foo.conf",
            "my-domain.com",
            "other-domain.com",
        ];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual(["foo.conf"]);
        expect(result.domains).toEqual(["my-domain.com", "other-domain.com"]);
    });

    it("should throw on an unknown flag", () => {
        // Arrange
        const argv = ["--unknown-flag=true"];

        // Act
        const underTest = () => parseArgs(argv);

        // Assert
        expect(underTest).toThrow("Unknown flag: --unknown-flag");
    });

    it("should handle --conf-files with an empty value gracefully", () => {
        // Arrange
        const argv = ["--conf-files="];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual([]);
    });

    it("should parse --conf-files with a newline-separated value (multiline env var from GH Actions)", () => {
        // Arrange — simulates CONF_FILES env var with blank lines from false conditionals
        const argv = ["--conf-files=\npath/to/foo.conf\n\npath/to/bar.conf\n"];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual([
            "path/to/foo.conf",
            "path/to/bar.conf",
        ]);
    });

    it("should parse --conf-files when value starts with a newline (first conditional was false)", () => {
        // Arrange — first conditional resolves to empty, so value starts with \n
        const argv = ["--conf-files=\npath/to/gcloud.conf\n\n"];

        // Act
        const result = parseArgs(argv);

        // Assert
        expect(result.confFiles).toEqual(["path/to/gcloud.conf"]);
    });
});

// ---------------------------------------------------------------------------
// validateDomain
// ---------------------------------------------------------------------------

describe("validateDomain", () => {
    it.each([
        ["github.com", true],
        ["api.github.com", true],
        ["*.foo.com", true],
        ["*.my-service.internal", true],
        ["single", true],
        ["a", true],
        ["bad domain", false],
        ["-bad.com", false],
        ["*.", false],
        ["", false],
        ["has space.com", false],
        ["has@symbol.com", false],
    ])("validateDomain(%s) === %s", (domain: string, expected: boolean) => {
        // Arrange — domain provided by it.each

        // Act
        const result = validateDomain(domain);

        // Assert
        expect(result).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// parseNameservers
// ---------------------------------------------------------------------------

describe("parseNameservers", () => {
    it("should extract a single non-loopback nameserver", () => {
        // Arrange
        const content = "nameserver 8.8.8.8\n";

        // Act
        const result = parseNameservers(content);

        // Assert
        expect(result).toEqual(["8.8.8.8"]);
    });

    it("should filter out loopback addresses", () => {
        // Arrange
        const content = "nameserver 127.0.0.1\nnameserver 127.0.0.53\n";

        // Act
        const result = parseNameservers(content);

        // Assert
        expect(result).toEqual([]);
    });

    it("should return only non-loopback entries from a mixed list", () => {
        // Arrange
        const content =
            "nameserver 8.8.8.8\nnameserver 127.0.0.53\nnameserver 1.1.1.1\n";

        // Act
        const result = parseNameservers(content);

        // Assert
        expect(result).toEqual(["8.8.8.8", "1.1.1.1"]);
    });

    it("should ignore non-nameserver lines", () => {
        // Arrange
        const content =
            "search foo.local\n# comment\nnameserver 10.0.0.1\ndomain foo.local\n";

        // Act
        const result = parseNameservers(content);

        // Assert
        expect(result).toEqual(["10.0.0.1"]);
    });

    it("should return empty array for content with no nameserver lines", () => {
        // Arrange
        const content = "search foo.local\n";

        // Act
        const result = parseNameservers(content);

        // Assert
        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// parseSearchDomains
// ---------------------------------------------------------------------------

describe("parseSearchDomains", () => {
    it("should parse a single search domain", () => {
        // Arrange
        const content = "search foo.local\n";

        // Act
        const result = parseSearchDomains(content);

        // Assert
        expect(result).toEqual(["foo.local"]);
    });

    it("should parse multiple search domains from one line", () => {
        // Arrange
        const content = "search foo.local bar.local baz.internal\n";

        // Act
        const result = parseSearchDomains(content);

        // Assert
        expect(result).toEqual(["foo.local", "bar.local", "baz.internal"]);
    });

    it("should return empty array when no search line exists", () => {
        // Arrange
        const content = "nameserver 8.8.8.8\n";

        // Act
        const result = parseSearchDomains(content);

        // Assert
        expect(result).toEqual([]);
    });

    it("should ignore nameserver lines and only read search", () => {
        // Arrange
        const content = "nameserver 10.0.0.1\nsearch corp.internal\n";

        // Act
        const result = parseSearchDomains(content);

        // Assert
        expect(result).toEqual(["corp.internal"]);
    });
});

// ---------------------------------------------------------------------------
// parseGithubActionsDomains
// ---------------------------------------------------------------------------

describe("parseGithubActionsDomains", () => {
    it("should format full_domains as local-zone transparent entries", () => {
        // Arrange
        const meta = {
            domains: {
                actions_inbound: {
                    full_domains: ["actions.github.com", "api.github.com"],
                    wildcard_domains: [],
                },
            },
        };

        // Act
        const result = parseGithubActionsDomains(meta);

        // Assert
        expect(result).toContain(
            'local-zone: "actions.github.com" transparent',
        );
        expect(result).toContain('local-zone: "api.github.com" transparent');
    });

    it("should format wildcard_domains as local-zone transparent entries", () => {
        // Arrange
        const meta = {
            domains: {
                actions_inbound: {
                    full_domains: [],
                    wildcard_domains: ["*.actions.githubusercontent.com"],
                },
            },
        };

        // Act
        const result = parseGithubActionsDomains(meta);

        // Assert
        expect(result).toContain(
            'local-zone: "actions.githubusercontent.com" transparent',
        );
    });

    it("should return empty array when actions_inbound is missing", () => {
        // Arrange
        const meta = {domains: {}};

        // Act
        const result = parseGithubActionsDomains(meta);

        // Assert
        expect(result).toEqual([]);
    });

    it("should return empty array for null/undefined input", () => {
        // Arrange
        const meta = null;

        // Act
        const result = parseGithubActionsDomains(meta);

        // Assert
        expect(result).toEqual([]);
    });

    it("should handle missing wildcard_domains gracefully", () => {
        // Arrange
        const meta = {
            domains: {
                actions_inbound: {
                    full_domains: ["github.com"],
                },
            },
        };

        // Act
        const result = parseGithubActionsDomains(meta);

        // Assert
        expect(result).toEqual(['local-zone: "github.com" transparent']);
    });
});

// ---------------------------------------------------------------------------
// buildAllowlistLines
// ---------------------------------------------------------------------------

describe("buildAllowlistLines", () => {
    it("should always start with the deny-all rule", () => {
        // Arrange
        const searchDomains: string[] = [];
        const extraDomains: string[] = [];
        const githubLines: string[] = [];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        expect(result).toContain('local-zone: "." refuse');
    });

    it("should include search domains as transparent zones", () => {
        // Arrange
        const searchDomains = ["corp.internal"];
        const extraDomains: string[] = [];
        const githubLines: string[] = [];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        expect(result).toContain('local-zone: "corp.internal" transparent');
    });

    it("should include extra domains and strip wildcard prefix", () => {
        // Arrange
        const searchDomains: string[] = [];
        const extraDomains = ["*.example.com", "plain.com"];
        const githubLines: string[] = [];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        expect(result).toContain('local-zone: "example.com" transparent');
        expect(result).toContain('local-zone: "plain.com" transparent');
    });

    it("should include pre-formatted GitHub domain lines verbatim", () => {
        // Arrange
        const searchDomains: string[] = [];
        const extraDomains: string[] = [];
        const githubLines = ['local-zone: "actions.github.com" transparent'];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        expect(result).toContain(
            'local-zone: "actions.github.com" transparent',
        );
    });

    it("should deduplicate identical lines", () => {
        // Arrange
        const searchDomains = ["dup.internal"];
        const extraDomains = ["dup.internal"];
        const githubLines = ['local-zone: "dup.internal" transparent'];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        const occurrences = result
            .split("\n")
            .filter(
                (l: string) => l === 'local-zone: "dup.internal" transparent',
            ).length;
        expect(occurrences).toBe(1);
    });

    it("should end with a trailing newline", () => {
        // Arrange
        const searchDomains: string[] = [];
        const extraDomains: string[] = [];
        const githubLines: string[] = [];

        // Act
        const result = buildAllowlistLines(
            searchDomains,
            extraDomains,
            githubLines,
        );

        // Assert
        expect(result.endsWith("\n")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildUnboundConf
// ---------------------------------------------------------------------------

describe("buildUnboundConf", () => {
    it("should include the provided upstream IP as a forward-addr", () => {
        // Arrange
        const upstreamIps = ["10.0.0.1"];

        // Act
        const result = buildUnboundConf(upstreamIps);

        // Assert
        expect(result).toContain("forward-addr: 10.0.0.1");
    });

    it("should always append Cloudflare fallback addresses", () => {
        // Arrange
        const upstreamIps = ["8.8.8.8"];

        // Act
        const result = buildUnboundConf(upstreamIps);

        // Assert
        expect(result).toContain("forward-addr: 1.1.1.1");
        expect(result).toContain("forward-addr: 1.0.0.1");
    });

    it("should include the allowlist include directive", () => {
        // Arrange
        const upstreamIps: string[] = [];

        // Act
        const result = buildUnboundConf(upstreamIps);

        // Assert
        expect(result).toContain('include: "/etc/unbound/allowlist.conf"');
    });

    it("should include multiple upstream IPs", () => {
        // Arrange
        const upstreamIps = ["10.0.0.1", "10.0.0.2"];

        // Act
        const result = buildUnboundConf(upstreamIps);

        // Assert
        expect(result).toContain("forward-addr: 10.0.0.1");
        expect(result).toContain("forward-addr: 10.0.0.2");
    });
});

// ---------------------------------------------------------------------------
// loadAllowlistFile
// ---------------------------------------------------------------------------

function writeTempConf(content: string): string {
    const tmpFile = path.join(
        os.tmpdir(),
        `secure-network-test-${Date.now()}.conf`,
    );
    fs.writeFileSync(tmpFile, content, "utf8");
    return tmpFile;
}

describe("loadAllowlistFile", () => {
    it("should return domain entries, stripping comment lines and blank lines", () => {
        // Arrange
        const tmpFile = writeTempConf(
            "# This is a comment\ngithub.com\n\napi.github.com\n# another comment\nraw.githubusercontent.com\n",
        );

        // Act
        const result = loadAllowlistFile(tmpFile);

        // Assert
        expect(result).toEqual([
            "github.com",
            "api.github.com",
            "raw.githubusercontent.com",
        ]);
    });

    it("should strip inline comments", () => {
        // Arrange
        const tmpFile = writeTempConf("example.com # inline comment\n");

        // Act
        const result = loadAllowlistFile(tmpFile);

        // Assert
        expect(result).toEqual(["example.com"]);
    });

    it("should return empty array for a file with only comments and blank lines", () => {
        // Arrange
        const tmpFile = writeTempConf("# comment\n\n# another\n");

        // Act
        const result = loadAllowlistFile(tmpFile);

        // Assert
        expect(result).toEqual([]);
    });

    it("should read domains from the given file path", () => {
        // Arrange
        const tmpFile = writeTempConf("example.com\nother.org\n");

        // Act
        const result = loadAllowlistFile(tmpFile);

        // Assert
        expect(result).toEqual(["example.com", "other.org"]);
    });
});

// ---------------------------------------------------------------------------
// stripWildcard
// ---------------------------------------------------------------------------

describe("stripWildcard", () => {
    it.each([
        ["*.foo.com", "foo.com"],
        ["*.sub.example.org", "sub.example.org"],
        ["foo.com", "foo.com"],
        ["plain", "plain"],
        ["*", "*"],
    ])("stripWildcard(%s) === %s", (input: string, expected: string) => {
        // Arrange — input provided by it.each

        // Act
        const result = stripWildcard(input);

        // Assert
        expect(result).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe("mapWithConcurrency", () => {
    it("should return results in input order", async () => {
        // Arrange
        const items = [30, 10, 20];

        // Act
        const result = await mapWithConcurrency(
            items,
            2,
            async (ms: number) => {
                await new Promise((r) => setTimeout(r, ms));
                return ms * 2;
            },
        );

        // Assert
        expect(result).toEqual([60, 20, 40]);
    });

    it("should not run more than the limit at once", async () => {
        // Arrange
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({length: 20}, (_, i) => i);

        // Act
        await mapWithConcurrency(items, 4, async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight--;
        });

        // Assert
        expect(maxInFlight).toBe(4);
    });

    it("should return an empty array for no items", async () => {
        // Arrange
        const fn = vi.fn();

        // Act
        const result = await mapWithConcurrency([], 4, fn);

        // Assert
        expect(result).toEqual([]);
        expect(fn).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

const jsonResponse = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

describe("fetchWithRetry", () => {
    const opts = {retryDelayMs: 0};

    it("should send the token as a Bearer Authorization header", async () => {
        // Arrange
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {a: 1}));

        // Act
        const result = await fetchWithRetry("https://x", {
            ...opts,
            token: "abc",
            fetchImpl,
        });

        // Assert
        expect(result).toEqual({a: 1});
        expect(fetchImpl.mock.calls[0]?.[1].headers.Authorization).toBe(
            "Bearer abc",
        );
    });

    it("should send no Authorization header without a token", async () => {
        // Arrange
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));

        // Act
        await fetchWithRetry("https://x", {...opts, fetchImpl});

        // Assert
        expect(fetchImpl.mock.calls[0]?.[1].headers).not.toHaveProperty(
            "Authorization",
        );
    });

    it.each([401, 403, 404, 429])(
        "should not retry on HTTP %s",
        async (status) => {
            // Arrange
            const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status));

            // Act
            const promise = fetchWithRetry("https://x", {...opts, fetchImpl});

            // Assert
            await expect(promise).rejects.toThrow(`HTTP ${status}`);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it("should retry on 5xx and then succeed", async () => {
        // Arrange
        vi.spyOn(console, "log").mockImplementation(() => {});
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(502))
            .mockResolvedValueOnce(jsonResponse(200, {ok: true}));

        // Act
        const result = await fetchWithRetry("https://x", {...opts, fetchImpl});

        // Assert
        expect(result).toEqual({ok: true});
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("should retry network errors up to maxAttempts", async () => {
        // Arrange
        vi.spyOn(console, "log").mockImplementation(() => {});
        const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

        // Act
        const promise = fetchWithRetry("https://x", {
            ...opts,
            maxAttempts: 3,
            fetchImpl,
        });

        // Assert
        await expect(promise).rejects.toThrow("ECONNRESET");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});
