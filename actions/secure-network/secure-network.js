#!/usr/bin/env node

/**
 * This script sets up a DNS firewall to block all outbound DNS traffic except
 * for the domains that are explicitly allowed. It uses Unbound to forward DNS
 * queries to the upstream DNS servers.
 *
 *
 * This script is largely based off of the one provided here:
 * https://www.kenmuse.com/blog/restricting-ip-access-on-github-hosted-runners/
 * But with additional tweaks to make it work on both Github Runners and our
 * self-hosted runners in Cloud Run.
 *
 * We want to make sure that this logic is able to run in both Github Runners
 * and our self-hosted runners in Cloud Run as we can sometimes switch between
 * the two.
 *
 * NOTE: This script needs to run as root in order to set up everything it needs.
 *
 * Usage:
 *   sudo node secure-network.js [options]
 *
 * Options:
 *   --conf-files=<paths>     Newline-, space-, or comma-separated paths to .conf allowlist
 *                            files to load. Blank/empty entries are silently ignored (useful
 *                            when callers construct the list with conditional expressions).
 *   --extra-domains=<list>   Space-separated list of additional domains to allow.
 *
 * github.conf (bundled alongside this script) is always loaded automatically.
 */

/* eslint-disable no-console */
const {execSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Cloudflare DNS IPs used both as unbound forward fallbacks and for DoH blocking.
const CLOUDFLARE_DNS_IPS = ["1.1.1.1", "1.0.0.1"];

// DoH provider IPs to block via iptables.
const DOH_PROVIDER_IPV4 = {
    Cloudflare: [...CLOUDFLARE_DNS_IPS, "104.16.248.249", "104.16.249.249"],
    Google: ["8.8.8.8", "8.8.4.4"],
    Quad9: ["9.9.9.9"],
    OpenDNS: ["208.67.222.222", "208.67.220.220"],
};
const DOH_PROVIDER_IPV6 = {
    Cloudflare: ["2606:4700:4700::1111", "2606:4700:4700::1001"],
    Google: ["2001:4860:4860::8888", "2001:4860:4860::8844"],
    Quad9: ["2620:fe::fe"],
    OpenDNS: ["2620:119:35::35", "2620:119:53::53"],
};

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse process.argv-style arguments into conf file paths and positional domains.
 * @param {string[]} argv
 * @returns {{confFiles: string[], domains: string[]}}
 */
function parseArgs(argv) {
    const confFiles = [];
    const domains = [];

    for (const arg of argv) {
        const match = arg.match(/^--([^=]+)=(.*)$/);
        if (match) {
            const [, key, value] = match;
            if (key === "conf-files") {
                // Split by comma, newline, or whitespace; filter empty strings
                // (handles blank lines from GH Actions conditional expressions
                // resolving to '').
                confFiles.push(
                    ...value
                        .split(/[\s,]+/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                );
            } else if (key === "extra-domains") {
                // Space-separated list of additional domains to allow.
                domains.push(
                    ...value
                        .split(/\s+/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                );
            } else {
                throw new Error(`Unknown flag: --${key}`);
            }
        } else {
            domains.push(arg);
        }
    }

    return {confFiles, domains};
}

/**
 * Returns true if the domain is syntactically valid (optionally wildcard-prefixed).
 * @param {string} domain
 * @returns {boolean}
 */
function validateDomain(domain) {
    return /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain);
}

/**
 * Extract non-loopback nameserver IPs from resolv.conf content.
 * @param {string} content
 * @returns {string[]}
 */
function parseNameservers(content) {
    return content
        .split("\n")
        .filter((line) => /^nameserver\s/.test(line))
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((ip) => !/^127\./.test(ip));
}

/**
 * Extract search domain list from resolv.conf content.
 * @param {string} content
 * @returns {string[]}
 */
function parseSearchDomains(content) {
    const searchLine = content
        .split("\n")
        .find((line) => /^search\s/.test(line));
    if (!searchLine) {
        return [];
    }
    return searchLine.trim().split(/\s+/).slice(1).filter(Boolean);
}

/**
 * Build Unbound local-zone lines from the GitHub meta API JSON response.
 * @param {object} metaJson
 * @returns {string[]}
 */
function parseGithubActionsDomains(metaJson) {
    const inbound = metaJson?.domains?.actions_inbound;
    if (!inbound) {
        return [];
    }
    const lines = [];
    for (const d of inbound.full_domains ?? []) {
        lines.push(`local-zone: "${d}" transparent`);
    }
    for (const d of inbound.wildcard_domains ?? []) {
        lines.push(`local-zone: "${stripWildcard(d)}" transparent`);
    }
    return lines;
}

/**
 * Assemble and deduplicate all allowlist entries into a single config string.
 * @param {string[]} searchDomains
 * @param {string[]} extraDomains  Already-stripped or raw domain strings
 * @param {string[]} githubDomainLines  Pre-formatted local-zone lines
 * @returns {string}
 */
function buildAllowlistLines(searchDomains, extraDomains, githubDomainLines) {
    const lines = [];
    lines.push("# Deny all domains by default");
    lines.push('local-zone: "." refuse');

    if (searchDomains.length > 0) {
        lines.push("# Allow internal search domains");
        for (const d of searchDomains) {
            lines.push(`local-zone: "${d}" transparent`);
        }
    }

    if (extraDomains.length > 0) {
        lines.push("# Caller-supplied allowed domains");
        for (const d of extraDomains) {
            // Strip leading '*.' — Unbound local-zones are inherently
            // wildcard-inclusive, so '*.foo.com' must be written as 'foo.com'.
            lines.push(`local-zone: "${stripWildcard(d)}" transparent`);
        }
    }

    if (githubDomainLines.length > 0) {
        lines.push("# GitHub Actions domains");
        lines.push(...githubDomainLines);
    }

    // Deduplicate while preserving order (mirrors awk '!seen[$0]++').
    const seen = new Set();
    return (
        lines
            .filter((line) => {
                if (seen.has(line)) {
                    return false;
                }
                seen.add(line);
                return true;
            })
            .join("\n") + "\n"
    );
}

/**
 * Return a complete unbound.conf string for the given upstream IPs.
 * Cloudflare (CLOUDFLARE_DNS_IPS) is always appended as a fallback.
 * @param {string[]} upstreamIps
 * @returns {string}
 */
function buildUnboundConf(upstreamIps) {
    const forwardAddrs = [...upstreamIps, ...CLOUDFLARE_DNS_IPS]
        .map((ip) => `    forward-addr: ${ip}`)
        .join("\n");

    return `server:
    interface: 127.0.0.1
    access-control: 127.0.0.0/8 allow
    hide-identity: yes
    hide-version: yes
    num-threads: 2
    outgoing-range: 512
    msg-cache-size: 4m
    rrset-cache-size: 8m
    prefetch: yes
    cache-min-ttl: 3600
    logfile: "/tmp/unbound.log"
    verbosity: 3
    log-queries: yes
    include: "/etc/unbound/allowlist.conf"

forward-zone:
    name: "."
${forwardAddrs}
`;
}

/**
 * Read a .conf allowlist file, strip comment lines and blank lines, and
 * return the remaining entries as an array.
 * @param {string} filePath
 * @returns {string[]}
 */
function loadAllowlistFile(filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    return content
        .split("\n")
        .map((line) => line.replace(/#.*$/, "").trim())
        .filter(Boolean);
}

/**
 * Remove a leading '*.' wildcard prefix from a domain, if present.
 * @param {string} domain
 * @returns {string}
 */
function stripWildcard(domain) {
    return domain.startsWith("*.") ? domain.slice(2) : domain;
}

// ---------------------------------------------------------------------------
// I/O helpers (not unit-tested)
// ---------------------------------------------------------------------------

function run(cmd) {
    execSync(cmd, {stdio: "inherit"});
}

function runQuiet(cmd) {
    return execSync(cmd, {stdio: "pipe", encoding: "utf8"}).trim();
}

function blockDoH(table, action, ips) {
    for (const ip of ips) {
        run(`${table} -A OUTPUT -d ${ip} -p tcp --dport 443 -j ${action}`);
    }
}

async function fetchWithRetry(
    url,
    {maxAttempts = 10, retryDelayMs = 2000, timeoutMs = 10000} = {},
) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, {signal: controller.signal});
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return await res.json();
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            if (attempt === maxAttempts) {
                throw err;
            }
            console.log(
                `  Attempt ${attempt} failed (${err.message}); retrying in ${
                    retryDelayMs / 1000
                }s...`,
            );
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

let resolvConfBakExists = false;

process.on("exit", (code) => {
    if (code !== 0 && resolvConfBakExists) {
        console.error(
            `ERROR: Script failed (exit ${code}), restoring original /etc/resolv.conf...`,
        );
        try {
            execSync("chattr -i /etc/resolv.conf", {stdio: "pipe"});
        } catch (_) {
            /* ignore */
        }
        try {
            fs.copyFileSync("/etc/resolv.conf.bak", "/etc/resolv.conf");
            console.error("Restored /etc/resolv.conf from backup.");
        } catch (_) {
            /* ignore */
        }
    }
    try {
        fs.unlinkSync("/etc/resolv.conf.bak");
    } catch (_) {
        /* ignore */
    }
});

async function main() {
    console.log("Starting Unbound DNS firewall setup...");

    // --- Parse args ---
    const {confFiles, domains: extraDomains} = parseArgs(process.argv.slice(2));

    // --- Step 0: Install dependencies ---
    console.log(
        "Installing required packages (skipping already-installed ones)...",
    );
    const pkgsNeeded = ["unbound", "dnsutils"].filter((pkg) => {
        try {
            runQuiet(`dpkg -s ${pkg}`);
            return false;
        } catch (_) {
            return true;
        }
    });
    if (pkgsNeeded.length > 0) {
        console.log(`Installing: ${pkgsNeeded.join(" ")}`);
        process.env.DEBIAN_FRONTEND = "noninteractive";
        run(
            `apt-get install -y --no-install-recommends ${pkgsNeeded.join(
                " ",
            )}`,
        );
    } else {
        console.log("All required packages already installed.");
    }

    // --- Step 1: Validate caller-supplied domains ---
    for (const domain of extraDomains) {
        if (!validateDomain(domain)) {
            console.error(`ERROR: Invalid domain: ${domain}`);
            process.exit(1);
        }
    }

    // --- Load allowlist domains ---
    // Always load the bundled github.conf, then any caller-supplied conf files.
    const allDomains = [
        ...loadAllowlistFile(path.join(__dirname, "github.conf")),
        ...confFiles.flatMap((p) => loadAllowlistFile(path.resolve(p))),
        ...extraDomains,
    ];

    // --- Step 2: Discover upstream DNS ---
    console.log("Detecting upstream DNS servers from /etc/resolv.conf...");
    const resolvContent = fs.readFileSync("/etc/resolv.conf", "utf8");
    let upstreamDns = parseNameservers(resolvContent);
    const searchDomains = parseSearchDomains(resolvContent);

    // If resolv.conf only lists loopback stubs (common on Ubuntu with
    // systemd-resolved), read the real upstream from systemd-resolved's config.
    if (upstreamDns.length === 0) {
        const fallbackPath = "/run/systemd/resolve/resolv.conf";
        if (fs.existsSync(fallbackPath)) {
            const fallbackContent = fs.readFileSync(fallbackPath, "utf8");
            upstreamDns = parseNameservers(fallbackContent);
            if (upstreamDns.length > 0) {
                console.log(
                    `Detected loopback stub resolver; using real upstream: ${upstreamDns.join(
                        " ",
                    )}`,
                );
            }
        }
    }

    if (upstreamDns.length === 0) {
        console.error(
            "ERROR: Could not determine upstream DNS servers. Exiting.",
        );
        process.exit(1);
    }
    console.log(`Found upstream DNS servers: ${upstreamDns.join(" ")}`);
    if (searchDomains.length > 0) {
        console.log(`Found search domain: ${searchDomains.join(" ")}`);
    }

    // --- Step 3: Fetch GitHub Actions domains (while DNS still works) ---
    console.log("Fetching GitHub Actions domains...");
    let githubMeta;
    try {
        githubMeta = await fetchWithRetry("https://api.github.com/meta");
    } catch (_) {
        const fallbackPath = path.join(__dirname, "github-meta.json");
        console.log(
            `WARN: Failed to fetch GitHub meta API after 10 attempts. Falling back to ${fallbackPath}`,
        );
        githubMeta = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
    }
    const githubActionsDomainLines = parseGithubActionsDomains(githubMeta);
    if (githubActionsDomainLines.length === 0) {
        console.error("ERROR: Failed to parse GitHub meta API response.");
        process.exit(1);
    }

    // --- Step 4: Configure Unbound ---
    console.log("Configuring Unbound to forward allowed traffic...");
    fs.writeFileSync(
        "/etc/unbound/unbound.conf",
        buildUnboundConf(upstreamDns),
    );

    // --- Step 5: Create the allowlist ---
    console.log("Building domain allowlist...");
    fs.writeFileSync(
        "/etc/unbound/allowlist.conf",
        buildAllowlistLines(
            searchDomains,
            allDomains,
            githubActionsDomainLines,
        ),
    );

    // --- Step 6: Validate config, redirect DNS, start Unbound ---
    console.log("Validating Unbound config syntax...");
    run("unbound-checkconf /etc/unbound/unbound.conf");

    console.log("Saving original DNS configuration...");
    fs.copyFileSync("/etc/resolv.conf", "/etc/resolv.conf.bak");
    resolvConfBakExists = true;

    console.log("Starting Unbound...");
    // Stop any existing instance so it doesn't hold port 53 with the default
    // (allow-all) config. No-op on runners without systemd (e.g. Cloud Run).
    try {
        run("systemctl stop unbound");
    } catch (_) {
        /* no systemd in some envs */
    }
    run("unbound -c /etc/unbound/unbound.conf");

    console.log("Verifying Unbound is responding to queries...");
    let unboundReady = false;
    for (let i = 0; i < 5; i++) {
        try {
            const result = runQuiet(
                "dig @127.0.0.1 github.com A +short +timeout=2 +retry=0",
            );
            if (result) {
                unboundReady = true;
                break;
            }
        } catch (_) {
            /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (!unboundReady) {
        console.error(
            "ERROR: Unbound is not responding to DNS queries. Aborting.",
        );
        process.exit(1);
    }
    console.log("Unbound is running and responding to queries.");

    // Pre-warm the cache for all allowed domains before iptables goes up.
    // With cache-min-ttl=3600 these entries will stay cached for the entire
    // lifetime of the runner, surviving any transient DNS blips after lockdown.
    console.log("Pre-warming DNS cache...");
    const prewarm = (domain) => {
        try {
            const result = runQuiet(
                `dig @127.0.0.1 "${domain}" A +short +timeout=5 +retry=2`,
            );
            if (result) {
                console.log(
                    `  ✓ ${domain} (${result.replace(/\n/g, " ").trim()})`,
                );
            } else {
                console.log(
                    `  ✗ ${domain} (no A record — may be CNAME-only, IPv6-only, or unreachable)`,
                );
            }
        } catch (_) {
            console.log(
                `  ✗ ${domain} (no A record — may be CNAME-only, IPv6-only, or unreachable)`,
            );
        }
    };
    for (const domain of allDomains) {
        prewarm(stripWildcard(domain));
    }
    for (const line of githubActionsDomainLines) {
        const m = line.match(/local-zone: "([^"]+)"/);
        if (m) {
            prewarm(m[1]);
        }
    }

    console.log("Redirecting DNS to local Unbound resolver...");
    fs.writeFileSync("/etc/resolv.conf", "nameserver 127.0.0.1\n");
    // resolv.conf.bak is kept until process exit; the exit handler restores it on error.

    // --- Step 7: Configure iptables for IPv4 DNS ---
    console.log("Configuring iptables rules...");
    // Allow the 'unbound' user to make outbound DNS queries
    run(
        "iptables -A OUTPUT -p udp -m owner --uid-owner unbound -d 0/0 --dport 53 -j ACCEPT",
    );
    run(
        "iptables -A OUTPUT -p tcp -m owner --uid-owner unbound -d 0/0 --dport 53 -j ACCEPT",
    );
    // Allow DNS queries on the loopback interface (system -> unbound)
    run("iptables -A OUTPUT -p udp -d 127.0.0.1 --dport 53 -j ACCEPT");
    run("iptables -A OUTPUT -p tcp -d 127.0.0.1 --dport 53 -j ACCEPT");
    // Block all other outbound DNS traffic
    run("iptables -A OUTPUT -p udp --dport 53 -j REJECT");
    run("iptables -A OUTPUT -p tcp --dport 53 -j REJECT");
    console.log("iptables configuration complete.");

    // --- Step 8: Configure ip6tables for IPv6 DNS (best-effort) ---
    let hasIpv6 = false;
    try {
        runQuiet("ip6tables -L -n");
        hasIpv6 = true;
    } catch (_) {
        /* not available */
    }

    if (hasIpv6) {
        console.log("Configuring ip6tables rules...");
        // Allow the 'unbound' user to make outbound DNS queries over IPv6
        run(
            "ip6tables -A OUTPUT -p udp -m owner --uid-owner unbound -d ::/0 --dport 53 -j ACCEPT",
        );
        run(
            "ip6tables -A OUTPUT -p tcp -m owner --uid-owner unbound -d ::/0 --dport 53 -j ACCEPT",
        );
        // Allow DNS queries to localhost over IPv6
        run("ip6tables -A OUTPUT -p udp -d ::1 --dport 53 -j ACCEPT");
        run("ip6tables -A OUTPUT -p tcp -d ::1 --dport 53 -j ACCEPT");
        // Block all other outbound IPv6 DNS traffic.
        // Use DROP instead of REJECT: the ip6t_REJECT kernel module is not
        // available in all environments (e.g. some Cloud Run containers).
        run("ip6tables -A OUTPUT -p udp --dport 53 -j DROP");
        run("ip6tables -A OUTPUT -p tcp --dport 53 -j DROP");
        console.log("ip6tables configuration complete.");
    } else {
        console.log("WARN: IPv6 not available, skipping ip6tables rules.");
    }

    // --- Step 9: Block DNS-over-TLS (port 853) ---
    console.log("Blocking DNS-over-TLS...");
    run("iptables -A OUTPUT -p tcp --dport 853 -j REJECT");
    if (hasIpv6) {
        run("ip6tables -A OUTPUT -p tcp --dport 853 -j DROP");
    }

    // --- Step 10: Block DNS-over-HTTPS providers ---
    console.log("Blocking known DNS-over-HTTPS providers...");
    for (const [provider, ips] of Object.entries(DOH_PROVIDER_IPV4)) {
        console.log(`  Blocking ${provider} DoH (IPv4)...`);
        blockDoH("iptables", "REJECT", ips);
    }
    if (hasIpv6) {
        for (const [provider, ips] of Object.entries(DOH_PROVIDER_IPV6)) {
            console.log(`  Blocking ${provider} DoH (IPv6)...`);
            blockDoH("ip6tables", "DROP", ips);
        }
    }
    console.log("DNS-over-HTTPS/TLS blocking complete.");

    // --- Step 11: Lock down configuration files (best-effort) ---
    console.log("Locking down configuration files...");
    for (const f of [
        "/etc/unbound/unbound.conf",
        "/etc/unbound/allowlist.conf",
        "/etc/resolv.conf",
    ]) {
        try {
            run(`chattr +i ${f}`);
        } catch (_) {
            console.log(
                `WARN: chattr not available, skipping immutable flag on ${f}`,
            );
        }
    }

    // --- Step 12: Final end-to-end DNS verification through system resolver ---
    console.log(
        "Final DNS verification (system resolver → Unbound → upstream)...",
    );
    let verifyFailed = false;
    for (const domain of allDomains) {
        const bare = stripWildcard(domain);
        try {
            const result = runQuiet(
                `dig "${bare}" A +short +timeout=5 +retry=1`,
            );
            if (result) {
                console.log(`  ✓ ${domain}`);
            } else {
                console.log(
                    `  ✗ ${domain} (FAILED — DNS broken for this domain after lockdown)`,
                );
                verifyFailed = true;
            }
        } catch (_) {
            console.log(
                `  ✗ ${domain} (FAILED — DNS broken for this domain after lockdown)`,
            );
            verifyFailed = true;
        }
    }
    if (verifyFailed) {
        console.error(
            "ERROR: Post-lockdown DNS verification failed. Unbound log:",
        );
        try {
            console.error(fs.readFileSync("/tmp/unbound.log", "utf8"));
        } catch (_) {
            console.error("(log not available)");
        }
        process.exit(1);
    }

    console.log("Unbound DNS firewall setup complete.");
}

// ---------------------------------------------------------------------------
// Exports (for unit testing) and entry point
// ---------------------------------------------------------------------------

module.exports = {
    parseArgs,
    validateDomain,
    parseNameservers,
    parseSearchDomains,
    parseGithubActionsDomains,
    buildAllowlistLines,
    buildUnboundConf,
    loadAllowlistFile,
    stripWildcard,
};

// Only run main when executed directly (not when require()'d by tests).
if (require.main === module) {
    main().catch((err) => {
        console.error(err.stack ?? err.message);
        process.exit(1);
    });
}
