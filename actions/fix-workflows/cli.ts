#!/usr/bin/env node
/**
 * CLI entrypoint for fix-workflows.
 *
 * Usage:
 *   pnpm dlx fix-workflows [--check-runs-on] [--config-file <path>]
 *       [--setup-action <action>]
 *
 * `--check-runs-on` checks every runs-on against the allowed-runs-on list in
 * the config file (.github/fix-workflows.yml unless --config-file says
 * otherwise); the pre-v4 `--fix-runs-on` is accepted as an alias for it.
 *
 * Fixes workflow lint violations and then formats all workflow YAML files
 * with oxfmt. Runs from the current working directory, expecting
 * .github/workflows/ to exist relative to it.
 */
import {execSync} from "node:child_process";
import * as path from "node:path";

import fixWorkflows, {
    type AnnotationProperties,
    generatedWorkflowSkipGlobs,
    parseCliArgs,
} from "./index";

let options: ReturnType<typeof parseCliArgs>;
try {
    options = parseCliArgs(process.argv.slice(2));
} catch (err) {
    console.error((err as Error).message); // eslint-disable-line no-console
    process.exit(1);
}

const core = {
    info: (message: string) => console.log(message), // eslint-disable-line no-console
    warning: (message: string) => console.warn(message), // eslint-disable-line no-console
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

fixWorkflows({core, ...options})
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
