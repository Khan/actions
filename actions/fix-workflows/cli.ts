#!/usr/bin/env node
/**
 * CLI entrypoint for fix-workflows.
 *
 * Usage:
 *   pnpm dlx fix-workflows [--check-runs-on] [--allowed-runs-on <value>]...
 *       [--setup-action <action>]
 *
 * `--check-runs-on` checks every runs-on against the allowlist; the pre-v4
 * `--fix-runs-on` is accepted as a deprecated alias for it.
 * `--allowed-runs-on` takes one runs-on value and may be repeated; without
 * it the default allowlist applies.
 *
 * Fixes workflow lint violations and then formats all workflow YAML files
 * with oxfmt. Runs from the current working directory, expecting
 * .github/workflows/ to exist relative to it.
 */
import {execSync} from "node:child_process";
import * as path from "node:path";

import fixWorkflows, {
    type AnnotationProperties,
    DEFAULT_SETUP_ACTION,
    generatedWorkflowSkipGlobs,
} from "./index";

function parseArgs(argv: string[]): {
    checkRunsOn: boolean;
    allowedRunsOn: string[];
    setupAction: string;
} {
    let checkRunsOn = false;
    const allowedRunsOn: string[] = [];
    let setupAction = DEFAULT_SETUP_ACTION;

    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--check-runs-on" || argv[i] === "--fix-runs-on") {
            checkRunsOn = true;
        } else if (argv[i] === "--allowed-runs-on" && i + 1 < argv.length) {
            allowedRunsOn.push(argv[++i]!);
        } else if (argv[i] === "--setup-action" && i + 1 < argv.length) {
            setupAction = argv[++i]!;
        }
    }

    return {checkRunsOn, allowedRunsOn, setupAction};
}

const {checkRunsOn, allowedRunsOn, setupAction} = parseArgs(process.argv);

const core = {
    info: (message: string) => console.log(message), // eslint-disable-line no-console
    error: (message: string, {file, startLine}: AnnotationProperties = {}) => {
        const where = file
            ? `${file}${startLine ? `:${startLine}` : ""}: `
            : "";
        console.error(`${where}${message}`); // eslint-disable-line no-console
    },
    setFailed: (message: string) => {
        console.error(message); // eslint-disable-line no-console
        process.exitCode = 1;
    },
};

fixWorkflows({core, checkRunsOn, allowedRunsOn, setupAction})
    .then(() => {
        // Format workflow files with oxfmt after fixing lint violations, skipping
        // the generator-owned ones for the same reason the fixer does (see
        // GENERATED_WORKFLOWS in index.ts). Negated globs rather than
        // .oxfmtrc.json ignorePatterns: the config lives beside this script, not in
        // the repo being formatted, and its patterns do not resolve against the
        // working directory.
        const configPath = path.join(__dirname, ".oxfmtrc.json");
        const skip = generatedWorkflowSkipGlobs()
            .map((glob) => JSON.stringify(glob))
            .join(" ");
        console.log("Formatting workflow files with oxfmt..."); // eslint-disable-line no-console
        execSync(
            `npx --yes oxfmt@0.44.0 --write --config ${JSON.stringify(
                configPath,
            )} ".github/workflows/**/*.yml" ${skip}`,
            {stdio: "inherit"},
        );
    })
    .catch((err: Error) => {
        console.error(err); // eslint-disable-line no-console
        process.exitCode = 1;
    });
