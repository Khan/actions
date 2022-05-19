/**
 * This script runs whenever a change lands to the 'main' branch,
 * publishing any new versions of actions that are needed.
 */
import { publishAsNeeded } from "./publish.mjs";

const [_, __, ...args] = process.argv;
const dryRun = args.includes('--dry-run');
const packageNames = fs.readdirSync('actions');
publishAsNeeded(packageNames, dryRun)
