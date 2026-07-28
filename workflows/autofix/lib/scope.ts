/**
 * The autofix label vocabulary and the scope it resolves to.
 *
 * The labels are namespaced `autofix: <value>`, and the namespace is FLAT while
 * the semantics are not: `autofix: blocking` and `autofix: loop` read as peers
 * but sit on different axes. Three axes exist, and writing them down here is
 * what keeps a later addition from quietly changing what an existing label
 * means:
 *
 *   - **scope** — which review findings are in scope. Labels union: a PR
 *     carrying both scope labels gets both classes fixed in one run.
 *   - **cadence** — how many autofix runs one arming authorises. Absent means
 *     `once`, which is the only cadence v1 implements.
 *   - **source** — whose feedback is fixed. Absent means the reviewer bot,
 *     which is the only source v1 implements.
 *
 * The combination rule is therefore: union within the scope axis, union within
 * the source axis, cadence is a flag. A label on an axis this version does not
 * implement is REJECTED rather than ignored ({@link UNIMPLEMENTED_LABELS}) — a
 * silently-dropped `autofix: loop` would look like a working loop that stopped
 * after one cycle, which is the worst of both behaviours.
 *
 * One constraint outlives v1 and is enforced here rather than left to
 * convention: **`nits` is never loop-eligible**. Non-blocking findings have no
 * fixed point (the reviewer will always find something cosmetic in the
 * autofixer's own output), so a nits-scoped loop cannot converge and must not
 * be offered. See {@link isLoopEligible}; when the cadence axis lands, the loop
 * label has to consult it.
 */

import {
    BLOCKING_LABELS,
    NON_BLOCKING_LABELS,
} from "../../review/lib/render-comment.ts";

/** Namespace every autofix label shares. */
export const AUTOFIX_LABEL_PREFIX = "autofix: ";

/**
 * The scope axis: which class of review finding a label puts in scope.
 * `blocking` is the default a repo reaches for (it terminates naturally at the
 * merge gate); `nits` is the deliberate one-shot tidy-up.
 */
export const AUTOFIX_SCOPES = ["blocking", "nits"] as const;

export type AutofixScope = typeof AUTOFIX_SCOPES[number];

/** Scope-axis label -> scope. The only labels v1 acts on. */
export const SCOPE_LABELS: Readonly<Record<string, AutofixScope>> = {
    "autofix: blocking": "blocking",
    "autofix: nits": "nits",
};

/**
 * Labels reserved for axes a later version implements. Listed so the resolver
 * can fail loudly and specifically ("not implemented yet") instead of treating
 * them as typos, and so nobody reuses one of these strings for something else.
 */
export const UNIMPLEMENTED_LABELS: Readonly<Record<string, string>> = {
    "autofix: loop": "the cadence axis (continual autofix) is not implemented",
    "autofix: human": "the source axis (human feedback) is not implemented",
    "autofix: author": "the source axis (author feedback) is not implemented",
};

/**
 * Whether a scope may ever be driven by a loop cadence. Blocking findings
 * terminate at the merge gate; non-blocking ones have no fixed point. v1 has no
 * loop, but the rule is encoded now because it is the constraint most likely to
 * be violated by whoever adds one later.
 */
export const isLoopEligible = (scope: AutofixScope): boolean =>
    scope === "blocking";

/** The Conventional-Comment labels a given autofix scope covers. */
export const findingLabelsForScope = (scope: AutofixScope): readonly string[] =>
    scope === "blocking" ? BLOCKING_LABELS : NON_BLOCKING_LABELS;

/** A resolved arming request: what this run was asked to do. */
export type AutofixRequest = {
    /** Scopes in effect, in {@link AUTOFIX_SCOPES} order, deduplicated. */
    scopes: AutofixScope[];
    /** The autofix labels that produced them; what the run must remove. */
    labels: string[];
    /** Every Conventional-Comment label the union of scopes covers. */
    findingLabels: string[];
};

export type ScopeResolution =
    | {status: "none"}
    | {status: "rejected"; reason: string; labels: string[]}
    | {status: "armed"; request: AutofixRequest};

/**
 * Resolve the PR's labels into an autofix request.
 *
 * `none` means no autofix label is present and the workflow should not have
 * run. `rejected` means an autofix-namespaced label is present that this
 * version cannot honour — an unimplemented axis, or an unrecognised value —
 * and the run must stop and say so rather than guess at an intent.
 */
export const resolveScope = (labels: readonly string[]): ScopeResolution => {
    const namespaced = labels.filter((label) =>
        label.startsWith(AUTOFIX_LABEL_PREFIX),
    );
    if (namespaced.length === 0) {
        return {status: "none"};
    }

    const unimplemented = namespaced.filter(
        (label) => UNIMPLEMENTED_LABELS[label] !== undefined,
    );
    if (unimplemented.length > 0) {
        return {
            status: "rejected",
            labels: unimplemented,
            reason: unimplemented
                .map((label) => `\`${label}\`: ${UNIMPLEMENTED_LABELS[label]}`)
                .join("; "),
        };
    }

    const unknown = namespaced.filter(
        (label) => SCOPE_LABELS[label] === undefined,
    );
    if (unknown.length > 0) {
        return {
            status: "rejected",
            labels: unknown,
            reason:
                `unrecognised autofix label(s): ` +
                `${unknown.map((l) => `\`${l}\``).join(", ")}. ` +
                `Known: ${Object.keys(SCOPE_LABELS)
                    .map((l) => `\`${l}\``)
                    .join(", ")}`,
        };
    }

    // Order by AUTOFIX_SCOPES, not by label order, so the request (and every
    // artifact rendered from it) is stable regardless of the order GitHub
    // happens to return the PR's labels in.
    const selected = new Set(namespaced.map((label) => SCOPE_LABELS[label]));
    const scopes = AUTOFIX_SCOPES.filter((scope) => selected.has(scope));

    return {
        status: "armed",
        request: {
            scopes: [...scopes],
            labels: scopes.map(
                (scope) =>
                    Object.keys(SCOPE_LABELS).find(
                        (label) => SCOPE_LABELS[label] === scope,
                    ) as string,
            ),
            findingLabels: scopes.flatMap((scope) => [
                ...findingLabelsForScope(scope),
            ]),
        },
    };
};
