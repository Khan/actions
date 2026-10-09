/**
 * Submission comparison has two different inputs: a pre-ingest plan and an
 * already-sanitized queue. Run the pinned sanitizer on the plan only. Replaying
 * tag conversion on the queue reparses code spans after URL redaction has eaten
 * backticks, and can turn a faithful transcription into a mismatch.
 *
 * The remaining symmetric folds are deliberate comparison tolerances, not a
 * second implementation of the sanitizer: comments, backticks, case, whitespace,
 * typographic punctuation and template escaping are ignored. URLs use upstream
 * protocol/domain redaction on both sides, with no allowed domains, so existing
 * same-host path/query tolerance remains but a changed host still blocks.
 *
 * This is not an ingest replay. Host-step context can differ (mention allowlists,
 * command/ref policy, bot-mention limits). Differences outside the documented
 * tolerances still fail closed, rather than enabling a permissive second reading.
 */
import {
    loadRunnerSanitizer,
    SanitizerUnavailableError,
} from "./sanitizer-runtime";
import type {SanitizerRuntime} from "./sanitizer-runtime";

/** Formatting-only equality, also used for pre-ingest bare-approval detection. */
export const normalizeBody = (text: string): string =>
    text
        .normalize("NFKC")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/[\u034f\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
        .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
        .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
        .replace(/`/g, "")
        .replace(/\\(?=[{$%#<])/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

export type BodyNormalization = {
    planned: (text: string) => string;
    queued: (text: string) => string;
};

/** Normalize each side once in its own role. Never modifies a posted body. */
export const createBodyNormalization = (
    runtime: SanitizerRuntime = loadRunnerSanitizer(),
): BodyNormalization => {
    const invoke = (fn: () => string): string => {
        try {
            const result = fn();
            if (typeof result !== "string") {
                throw new SanitizerUnavailableError("invocation");
            }
            runtime.clearRedactedDomains();
            return result;
        } catch {
            throw new SanitizerUnavailableError("invocation");
        }
    };
    const queued = (text: string): string =>
        invoke(() =>
            normalizeBody(
                runtime.sanitizeUrlDomains(
                    runtime.sanitizeUrlProtocols(text),
                    [],
                ),
            ),
        );
    return {
        planned: (text) =>
            queued(invoke(() => runtime.sanitizeContentCore(text))),
        queued,
    };
};

/** Host preflight uses fixed text, never PR content or an agent-written plan. */
export const verifyRunnerSanitizer = (): void => {
    const normalization = createBodyNormalization();
    const probe = "Sanitizer preflight";
    if (
        normalization.planned(probe) !== "sanitizer preflight" ||
        normalization.queued(probe) !== "sanitizer preflight"
    ) {
        throw new SanitizerUnavailableError("invocation");
    }
};
