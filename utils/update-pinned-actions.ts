/**
 * Scan all workflow and action YAML files for GitHub Action references and
 * ensure they are pinned to commit SHAs.
 *
 * Usage: node utils/update-pinned-actions.ts
 */
import {updatePinnedActions} from "./update-pinned-actions-lib.ts";

updatePinnedActions();
