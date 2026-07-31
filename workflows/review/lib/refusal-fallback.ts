/**
 * Refusal fallbacks: which model a role runs on when its pinned model refuses
 * the request outright.
 *
 * The hazard is documented but was mitigated on the wrong roles. review.md's
 * README explains that the specialist lenses stay on Opus "because Fable's
 * cyber safety classifiers can refuse benign security-focused analysis, and a
 * refused security lens would be a silent coverage hole" — while
 * `correctness-reviewer`, the default roster's load-bearing recall agent, was
 * moved ONTO Fable 5 by the 2026-07-20 A/B for its recall gain. Run
 * 30656579898 caught it doing exactly what the README warned the lenses would:
 *
 *     rawStopReason=refusal
 *     "This request triggered restrictions on violative cyber content and was
 *      blocked under Anthropic's Usage Policy."
 *
 * on the `incident-auth-bypass` and `adversarial-injection-approve` corpus
 * cases, at 5,207 tokens (so not a context problem).
 *
 * A refusal is INTERMITTENT, not deterministic: probe run 30658862532 saw the
 * same Fable pin clear both cases that run 30656579898 blocked. It is still not
 * recoverable by the ordinary retry, which appends a corrective note about
 * output shape — a blocked request never had an output-shape problem. Switching
 * to a model with a different refusal profile is the reliable recovery;
 * re-rolling the refusing pin is not. Anthropic's own refusal message points
 * integrators at a fallback model; gh-aw exposes no such parameter, but
 * scripted dispatch owns its runner, so the policy lives here instead.
 *
 * ONE hop only, and never silent: a fallback dispatch is recorded per agent so
 * the drift corpus and the run artifact can see how often it fires. Converting
 * a silent skip into a silent model swap would trade one invisible failure for
 * another.
 */

/**
 * Fallback target per pinned model. Opus 4.8 is the target because it is the
 * roster's incumbent for every security-sensitive role (all twelve specialist
 * lenses, `claim-validator`), chosen there for this exact property.
 *
 * Fable 5 is measured: it refuses. Opus 5 is listed on #294's own assessment
 * that it "ships elevated cybersecurity safeguards" and can return
 * `stop_reason: "refusal"` — a prediction, not a measurement, so it is here
 * pre-emptively and costs nothing until it fires.
 *
 * A model with no entry has no fallback: the refusal stands and is reported.
 * That is deliberate. Silently re-dispatching an unlisted model would hide the
 * next model family's refusal profile, which is the thing this map exists to
 * make visible.
 */
export const REFUSAL_FALLBACK: Readonly<Record<string, string>> = {
    "claude-fable-5": "claude-opus-4-8",
    "claude-opus-5": "claude-opus-4-8",
};

/**
 * The model to retry a refused dispatch on, or undefined when the pin has no
 * fallback or the fallback would loop back to a model that already refused.
 */
export const refusalFallbackFor = (
    model: string,
    alreadyTried: readonly string[] = [],
): string | undefined => {
    const fallback = REFUSAL_FALLBACK[model];
    if (fallback === undefined || alreadyTried.includes(fallback)) {
        return undefined;
    }
    return fallback;
};
