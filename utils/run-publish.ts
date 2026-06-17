/**
 * This script runs whenever a change lands to the 'main' branch,
 * publishing any new versions of actions and workflows that are needed.
 */
import * as fs from "fs";
import {publishAsNeeded, publishWorkflowsAsNeeded} from "./publish.ts";

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");

    const actionNames = fs
        .readdirSync("actions")
        .filter((name) => fs.statSync(`actions/${name}`).isDirectory());
    await publishAsNeeded(actionNames, dryRun, force);

    // Workflows (gh-aw agentic workflows) are published as plain git tags on the
    // real commit tree rather than as tree-rewritten bare commits — see
    // `publishWorkflowsAsNeeded`.
    if (fs.existsSync("workflows")) {
        const workflowNames = fs
            .readdirSync("workflows")
            .filter((name) => fs.statSync(`workflows/${name}`).isDirectory());
        publishWorkflowsAsNeeded(workflowNames, dryRun, force);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
