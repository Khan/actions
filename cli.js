#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * CLI entrypoint for fix-workflows.
 *
 * Usage:
 *   pnpm dlx fix-workflows [--fix-runs-on] [--config-file <path>]
 *       [--setup-action <action>]
 *
 * `--fix-runs-on` replaces every runs-on that isn't on the allowed-runs-on
 * list in the config file (.github/fix-workflows.yml unless --config-file
 * says otherwise) with the list's first entry, so one run fixes a whole repo.
 *
 * Fixes workflow lint violations and then formats all workflow YAML files
 * with oxfmt. Runs from the current working directory, expecting
 * .github/workflows/ to exist relative to it.
 */
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const index_1 = __importStar(require("./index"));
let options;
try {
    options = (0, index_1.parseCliArgs)(process.argv.slice(2));
}
catch (err) {
    console.error(err.message); // eslint-disable-line no-console
    process.exit(1);
}
const core = {
    info: (message) => console.log(message), // eslint-disable-line no-console
    warning: (message) => console.warn(message), // eslint-disable-line no-console
    setFailed: (message) => {
        console.error(message); // eslint-disable-line no-console
        process.exitCode = 1;
    },
};
(0, index_1.default)({ core, ...options })
    .then(() => {
    // Format workflow files with oxfmt after fixing lint violations, skipping
    // the generator-owned ones for the same reason the fixer does (see
    // GENERATED_WORKFLOWS in index.ts). Negated globs rather than
    // .oxfmtrc.json ignorePatterns: the config lives beside this script, not in
    // the repo being formatted, and its patterns do not resolve against the
    // working directory.
    const configPath = path.join(__dirname, ".oxfmtrc.json");
    const skip = (0, index_1.generatedWorkflowSkipGlobs)()
        .map((glob) => JSON.stringify(glob))
        .join(" ");
    console.log("Formatting workflow files with oxfmt..."); // eslint-disable-line no-console
    (0, node_child_process_1.execSync)(`npx --yes oxfmt@0.44.0 --write --config ${JSON.stringify(configPath)} ".github/workflows/**/*.yml" ${skip}`, { stdio: "inherit" });
})
    .catch((err) => {
    console.error(err); // eslint-disable-line no-console
    process.exitCode = 1;
});
