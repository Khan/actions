/**
 * The shared "one scored run" shape used by the slice-11 metrics, judge, and
 * gates. A corpus case paired with the {@link RunResult} the no-post runner
 * produced for it — the exact pairing `runSmokeCorpus` already returns, lifted to
 * a named type so metrics/judge/gates agree on their input without importing each
 * other. Kept in its own tiny module so the three consumers depend on a leaf, not
 * on one another.
 */

import type {CorpusCase} from "./corpus/loader";
import type {RunResult} from "./runner";

/** One corpus case together with the deterministic run result scored over it. */
export type EvalRun = {
    corpusCase: CorpusCase;
    result: RunResult;
};
