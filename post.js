#!/usr/bin/env node

/**
 * Post-job diagnostics for the secure-network GitHub Action.
 *
 * This script runs automatically after the job completes (success or failure)
 * via the `post:` field in action.yml. It dumps Unbound state, DNS resolution,
 * iptables rules, and the Unbound log so intermittent DNS failures can be
 * diagnosed from CI output alone.
 *
 * Exits 0 unconditionally — diagnostics must never fail the job.
 */

/* eslint-disable no-console */
const {execSync} = require("node:child_process");

function run(cmd) {
    try {
        execSync(`sudo sh -c ${JSON.stringify(cmd)}`, {stdio: "inherit"});
    } catch (_) {
        // best-effort — output whatever we got
    }
}

console.log("\n=== secure-network post-job diagnostics ===");

console.log("\n--- Unbound process ---");
run("pgrep -la unbound || echo 'WARN: Unbound not running!'");

console.log("\n--- /etc/resolv.conf ---");
run("cat /etc/resolv.conf");

console.log("\n--- DNS test: api.github.com ---");
run(
    "dig api.github.com A +short +timeout=3 +retry=0 || echo 'FAIL: DNS resolution failed'",
);

console.log("\n--- iptables OUTPUT chain ---");
run(
    "iptables -L OUTPUT -n --line-numbers 2>/dev/null || echo '(iptables not available)'",
);

console.log("\n--- Unbound log (last 60 lines) ---");
run("tail -60 /tmp/unbound.log 2>/dev/null || echo '(log not available)'");

console.log("\n===========================================\n");
