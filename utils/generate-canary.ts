/**
 * Re-derive .github/workflows/review-canary.md from review.md and recompile
 * .github/workflows/review-canary.lock.yml.
 *
 * Usage: node -r @swc-node/register utils/generate-canary.ts
 */
import {generateCanary} from "./generate-canary-lib.ts";

generateCanary();
