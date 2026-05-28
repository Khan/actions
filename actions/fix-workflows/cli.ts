#!/usr/bin/env node
/**
 * CLI entrypoint for fix-workflows.
 *
 * Usage:
 *   pnpm dlx fix-workflows [--fix-runs-on] [--setup-action <action>]
 *
 * Fixes workflow lint violations and then formats all workflow YAML files
 * with oxfmt. Runs from the current working directory, expecting
 * .github/workflows/ to exist relative to it.
 */
import {execSync} from "node:child_process";
import * as path from "node:path";

import fixWorkflows, {DEFAULT_SETUP_ACTION} from "./index";

function parseArgs(argv: string[]): {
    fixRunsOn: boolean;
    setupAction: string;
} {
    let fixRunsOn = false;
    let setupAction = DEFAULT_SETUP_ACTION;

    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--fix-runs-on") {
            fixRunsOn = true;
        } else if (argv[i] === "--setup-action" && i + 1 < argv.length) {
            setupAction = argv[++i];
        }
    }

    return {fixRunsOn, setupAction};
}

const {fixRunsOn, setupAction} = parseArgs(process.argv);

const core = {
    info: (message: string) => console.log(message), // eslint-disable-line no-console
    setFailed: (message: string) => {
        console.error(message); // eslint-disable-line no-console
        process.exitCode = 1;
    },
};

fixWorkflows({core, fixRunsOn, setupAction})
    .then(() => {
        // Format workflow files with oxfmt after fixing lint violations.
        const configPath = path.join(__dirname, ".oxfmtrc.json");
        console.log("Formatting workflow files with oxfmt..."); // eslint-disable-line no-console
        execSync(
            `npx --yes oxfmt@0.44.0 --write --config ${JSON.stringify(
                configPath,
            )} ".github/workflows/**/*.yml"`,
            {stdio: "inherit"},
        );
    })
    .catch((err: Error) => {
        console.error(err); // eslint-disable-line no-console
        process.exitCode = 1;
    });
