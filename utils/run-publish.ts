/**
 * This script runs whenever a change lands to the 'main' branch,
 * publishing any new versions of actions that are needed.
 */
import * as fs from "fs";
import {publishAsNeeded} from "./publish.ts";

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const packageNames = fs
        .readdirSync("actions")
        .filter((name) => fs.statSync(`actions/${name}`).isDirectory());

    await publishAsNeeded(packageNames, dryRun);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
