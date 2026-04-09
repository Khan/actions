#!/usr/bin/env node

/**
 * Entry point for the secure-network GitHub Action.
 *
 * GitHub Actions sets INPUT_* env vars from action inputs automatically.
 * We forward them to secure-network.js (which must run as root) via sudo env.
 */

/* eslint-disable no-console */
const {execSync} = require("node:child_process");
const path = require("node:path");

// GitHub Actions sets input names with hyphens as INPUT_CONF-FILES etc.
const confFiles = process.env["INPUT_CONF-FILES"] || "";
const extraDomains = process.env["INPUT_EXTRA-DOMAINS"] || "";

try {
    execSync(
        `sudo env ` +
            `"PATH=${process.env.PATH}" ` +
            `"CONF_FILES=${confFiles}" ` +
            `"EXTRA_DOMAINS=${extraDomains}" ` +
            `node "${path.join(__dirname, "secure-network.js")}"`,
        {stdio: "inherit"},
    );
} catch (err) {
    process.exit(err.status ?? 1);
}
