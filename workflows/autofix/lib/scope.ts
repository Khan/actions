/**
 * The autofix request vocabulary, and the scope it resolves to.
 *
 * Autofix is armed two ways, and they are peers: a namespaced `autofix: <value>`
 * label, or an `/autofix [value …]` PR comment. Both are first-class; neither is
 * a shorthand for the other. What they share is the **token** — the value after
 * the namespace — which is the single currency this module resolves. Both
 * surfaces funnel through {@link resolveTokens}, so a value can never mean one
 * thing as a label and another as a command.
 *
 * The token space is flat while the semantics are not. Three axes exist, and a
 * token names a value on exactly one of them:
 *
 *   - **scope** — which review findings are in scope. Tokens union: `blocking`
 *     and `nits` together fix both classes in one run.
 *   - **cadence** — how many autofix runs one arming authorises. Absent means
 *     `once`, which is the only cadence this version implements.
 *   - **source** — whose feedback is fixed. Absent means the reviewer bot, the
 *     only source this version implements.
 *
 * The combination rule is: union within the scope axis, union within the source
 * axis, cadence is a flag. Because unioning happens *within* an axis, the token
 * space stays bounded by the axes (five tokens across all three) rather than
 * growing as their product — there is no `blocking-loop` token, and there must
 * never be one.
 *
 * A token on an axis this version does not implement is REJECTED, not ignored
 * ({@link UNIMPLEMENTED_TOKENS}). A silently-dropped `loop` would look like a
 * working loop that stopped after one cycle, which is the worst of both
 * behaviours.
 *
 * One constraint outlives this version: **`nits` is never loop-eligible**.
 * Non-blocking findings have no fixed point, so a nits-scoped loop cannot
 * converge and must not be offered. What enforces that *here* is the token
 * table: `loop` is in {@link UNIMPLEMENTED_TOKENS}, so no cadence can be armed
 * at all. {@link isLoopEligible} states the rule for whoever adds the cadence
 * axis and has no caller until they write one; calling it is their job.
 *
 * The generator is a **memoryless re-derivation over the whole diff**, not the
 * fixer's own prose, which is what this comment used to guess.
 * Khan/webapp#41194 measured one blocking-scoped cycle: the fix cleared its
 * finding, the re-review resolved that thread and approved, and then filed two
 * fresh non-blocking findings against code the fixer never wrote (`counts.go:7`
 * is `func MergeCounts`, twelve lines above its first added line;
 * `counts.go:16` is a context line in its own hunk). That run planned
 * `no-prior-fingerprint`, so the reviewer's newly-changed-code scope filter was
 * a no-op and the whole diff was re-derived with no memory of the previous
 * review. Open non-blocking threads went 3 → 5 in one cycle with no nits-scoped
 * work done. The fixer does not have to have written anything for this to
 * happen.
 */

import {
    BLOCKING_LABELS,
    DOCUMENTATION_LABEL,
    NON_BLOCKING_LABELS,
} from "../../review/lib/render-comment.ts";

/** Namespace every autofix label shares. */
export const AUTOFIX_LABEL_PREFIX = "autofix: ";

/** The command form, at the start of a PR comment. */
export const AUTOFIX_COMMAND = "/autofix";

/**
 * The scope axis: which class of review finding a token puts in scope.
 * `blocking` is the default a repo reaches for (it terminates naturally at the
 * merge gate); `nits` is the deliberate one-shot tidy-up; `docs` is the
 * narrowest, and the only one whose edits cannot change program behaviour.
 *
 * **`docs` is a subset of `nits`, not a peer of it.** Documentation findings
 * are non-blocking, so `nits` already covers them and arming both is the same
 * as arming `nits`. The reason `docs` exists as its own token is that the
 * reverse is not true: arming `nits` to clear three stale comments also invites
 * the fixer into every other cosmetic thread on the PR. The flat namespace
 * cannot show this containment, so it is stated here and in the README.
 */
export const AUTOFIX_SCOPES = ["blocking", "nits", "docs"] as const;

export type AutofixScope = typeof AUTOFIX_SCOPES[number];

/**
 * Scope-axis tokens. The only tokens this version acts on.
 */
export const SCOPE_TOKENS: Readonly<Record<string, AutofixScope>> = {
    blocking: "blocking",
    nits: "nits",
    docs: "docs",
};

/**
 * Tokens reserved for axes a later version implements. Listed so the resolver
 * can fail loudly and specifically ("not implemented yet") instead of treating
 * them as typos, and so nobody reuses one of these strings for something else.
 */
export const UNIMPLEMENTED_TOKENS: Readonly<Record<string, string>> = {
    loop: "the cadence axis (continual autofix) is not implemented",
    human: "the source axis (human feedback) is not implemented",
    author: "the source axis (author feedback) is not implemented",
};

/** The label form of a token. */
export const labelForToken = (token: string): string =>
    `${AUTOFIX_LABEL_PREFIX}${token}`;

const byLabel = <T>(tokens: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(
        Object.entries(tokens).map(([token, value]) => [
            labelForToken(token),
            value,
        ]),
    );

/** Scope-axis label -> scope. Derived from {@link SCOPE_TOKENS}. */
export const SCOPE_LABELS: Readonly<Record<string, AutofixScope>> =
    byLabel(SCOPE_TOKENS);

/** Reserved labels -> why they are refused. Derived from the token table. */
export const UNIMPLEMENTED_LABELS: Readonly<Record<string, string>> =
    byLabel(UNIMPLEMENTED_TOKENS);

/**
 * The scope a bare `/autofix` means. Blocking, because it is the scope that
 * terminates at the merge gate and the one people reach for; a bare command
 * must not silently do the open-ended thing.
 *
 * There is deliberately NO bare `autofix` label equivalent. A label carries no
 * arguments, so a bare label and a scoped one would be two ways to say the same
 * thing with nothing distinguishing them at a glance.
 */
export const DEFAULT_COMMAND_SCOPE: AutofixScope = "blocking";

/**
 * Whether a scope may ever be driven by a loop cadence. Blocking findings
 * terminate at the merge gate; non-blocking ones have no fixed point. This
 * version has no loop, but the rule is encoded now because it is the constraint
 * most likely to be violated by whoever adds one later.
 *
 * Note what `blocking`'s eligibility actually rests on: the merge gate is a
 * claim about a human eventually merging, not a termination proof, and nothing
 * in the reviewer backs it. The one mechanism that bounds re-flagging exempts
 * blocking from itself: `applyScopeFilter` in
 * `review/lib/dispatch-contracts.ts` keeps plain `issue (blocking)` /
 * `todo (blocking)` findings whether or not they land on newly-changed code, so
 * blocking is the one class that can be re-raised on previously-reviewed,
 * untouched lines every cycle. The scope filter bounds nits; it does not bound
 * blocking. A cadence axis needs its own stop condition and cannot inherit one
 * from this predicate.
 *
 * `docs` is the case worth pausing on, because it looks convergent and is only
 * half so. Its deletion half has a fixed point (a comment that restates the
 * code is either gone or not), which is exactly the argument someone will make
 * for looping it. Its other half does not: the documentation reviewer also
 * flags a *missing* explanation, the fixer answers with prose, and prose is
 * the thing a reviewer can always want written better. So `docs` stays
 * ineligible until something measures which half dominates in practice. That
 * is a claim about evidence we do not have, not a claim about the domain.
 */
export const isLoopEligible = (scope: AutofixScope): boolean =>
    scope === "blocking";

/**
 * The Conventional-Comment labels a given autofix scope covers.
 *
 * `docs` resolves to the single label the documentation reviewer mints. That
 * label is the only thing distinguishing a documentation thread from any other
 * nit by the time autofix sees it: the worklist reads threads off the PR and
 * parses their leading label, so nothing else about the finding survives.
 */
export const findingLabelsForScope = (
    scope: AutofixScope,
): readonly string[] => {
    switch (scope) {
        case "blocking":
            return BLOCKING_LABELS;
        case "docs":
            return [DOCUMENTATION_LABEL];
        case "nits":
            return NON_BLOCKING_LABELS;
    }
};

/** How this run was armed. Recorded so the summary can say which surface. */
export type RequestSurface = "label" | "command";

/** A resolved arming request: what this run was asked to do. */
export type AutofixRequest = {
    /** Which surface armed it. */
    surface: RequestSurface;
    /** Scopes in effect, in {@link AUTOFIX_SCOPES} order, deduplicated. */
    scopes: AutofixScope[];
    /**
     * The autofix labels this run must remove. Populated only for the `label`
     * surface: a comment is self-clearing, so a command-armed run has no label
     * state to tidy and must not go removing labels nobody acted on.
     */
    labels: string[];
    /** Every Conventional-Comment label the union of scopes covers. */
    findingLabels: string[];
};

export type ScopeResolution =
    | {status: "none"}
    /**
     * `surface` is carried on the rejection too, not just on success: the
     * caller decides whether to clear labels from it, and a command-armed
     * rejection must not go removing labels nobody acted on.
     */
    | {
          status: "rejected";
          surface: RequestSurface;
          reason: string;
          labels: string[];
      }
    | {status: "armed"; request: AutofixRequest};

/**
 * The shared core both surfaces resolve through.
 *
 * `render` turns a token back into the form the user actually typed, so a
 * rejection quotes their input rather than a normalised version of it.
 */
const resolveTokens = (
    tokens: readonly string[],
    surface: RequestSurface,
    render: (token: string) => string,
): ScopeResolution => {
    const unimplemented = tokens.filter(
        (token) => UNIMPLEMENTED_TOKENS[token] !== undefined,
    );
    if (unimplemented.length > 0) {
        return {
            status: "rejected",
            surface,
            labels: unimplemented.map(render),
            reason: unimplemented
                .map(
                    (token) =>
                        `\`${render(token)}\`: ${UNIMPLEMENTED_TOKENS[token]}`,
                )
                .join("; "),
        };
    }

    const unknown = tokens.filter((token) => SCOPE_TOKENS[token] === undefined);
    if (unknown.length > 0) {
        return {
            status: "rejected",
            surface,
            labels: unknown.map(render),
            reason:
                `unrecognised autofix ${surface}(s): ` +
                `${unknown.map((t) => `\`${render(t)}\``).join(", ")}. ` +
                `Known: ${Object.keys(SCOPE_TOKENS)
                    .map((t) => `\`${render(t)}\``)
                    .join(", ")}`,
        };
    }

    // Order by AUTOFIX_SCOPES, not by input order, so the request (and every
    // artifact rendered from it) is stable regardless of the order GitHub
    // returns labels in or the order someone typed the arguments.
    const selected = new Set(tokens.map((token) => SCOPE_TOKENS[token]));
    const scopes = AUTOFIX_SCOPES.filter((scope) => selected.has(scope));

    return {
        status: "armed",
        request: {
            surface,
            scopes: [...scopes],
            labels: surface === "label" ? scopes.map(labelForToken) : [],
            findingLabels: scopes.flatMap((scope) => [
                ...findingLabelsForScope(scope),
            ]),
        },
    };
};

/**
 * Resolve the PR's labels into an autofix request.
 *
 * `none` means no autofix label is present. `rejected` means an
 * autofix-namespaced label is present that this version cannot honour — an
 * unimplemented axis, or an unrecognised value — and the run must stop and say
 * so rather than guess at an intent.
 */
export const resolveScope = (labels: readonly string[]): ScopeResolution => {
    const namespaced = labels.filter((label) =>
        label.startsWith(AUTOFIX_LABEL_PREFIX),
    );
    if (namespaced.length === 0) {
        return {status: "none"};
    }
    return resolveTokens(
        namespaced.map((label) => label.slice(AUTOFIX_LABEL_PREFIX.length)),
        "label",
        labelForToken,
    );
};

/**
 * Match `/autofix` at the start of a comment body, requiring the command to be
 * followed by whitespace or end-of-body.
 *
 * The trailing-whitespace tolerance is not incidental. gh-aw's own
 * `slash_command` gate only matches a bare `\n` or end-of-body, so a comment
 * saved with a trailing CRLF — which the GitHub web UI produces when you press
 * Enter after the command — never activates the workflow. That cost Khan/webapp
 * a silently-dead `/review` (Khan/webapp#40943), which is why the reviewer there
 * uses a raw `issue_comment` trigger with its own gate, and why this parser and
 * the workflow's `if:` do the same.
 */
const COMMAND_RE = new RegExp(`^${AUTOFIX_COMMAND}(?=\\s|$)`);

/**
 * Resolve an `/autofix` comment body into an autofix request.
 *
 * Returns `none` when the body is not an autofix command at all, so the caller
 * can fall through to the label surface.
 *
 * Arguments are read from the command's own line only. Prose on later lines is
 * ignored rather than parsed as tokens, so
 * `/autofix blocking\n\nkeep the existing naming please` arms cleanly and the
 * context is still there for a human reading the thread.
 */
export const resolveCommand = (body: string): ScopeResolution => {
    const firstLine = body.trimStart().split(/\r?\n/, 1)[0] ?? "";
    if (!COMMAND_RE.test(firstLine)) {
        return {status: "none"};
    }

    const args = firstLine
        .slice(AUTOFIX_COMMAND.length)
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "");

    const tokens = args.length === 0 ? [DEFAULT_COMMAND_SCOPE] : args;
    return resolveTokens(
        tokens,
        "command",
        (token) => `${AUTOFIX_COMMAND} ${token}`,
    );
};
