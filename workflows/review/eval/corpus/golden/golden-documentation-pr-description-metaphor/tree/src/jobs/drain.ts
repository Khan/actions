import {claimJobs, runJob} from "./queue";

// 50 keeps one drain pass under the worker's 60s health-check interval:
// p95 job time is ~1.1s, and an unbounded pass was marked unhealthy and
// killed mid-drain during the 2026-07 backfill.
const MAX_JOBS_PER_PASS = 50;

export const drainQueue = async (): Promise<number> => {
    let handled = 0;
    for (const job of await claimJobs(MAX_JOBS_PER_PASS)) {
        await runJob(job);
        handled += 1;
    }
    return handled;
};
