/**
 * R16: dismissal-learning.
 *
 * The reviewer accumulates evidence that some findings are unwelcome where they
 * fire: bot threads a human resolved without a fix, 👎 reactions that came with a
 * reply, and cases where the author pushed back and was right. This module turns
 * that evidence into candidate **"do-not-flag-here" notes** — suppressions scoped
 * to a (lens, path) — and emits them as a **proposed change to a committed config
 * file that a human approves**. Nothing is ever auto-adopted (plan task-12-4 AC):
 * the module only proposes; applying the diff is a human commit.
 *
 * Why human-in-the-loop is structural, not incidental: a suppression is the one
 * place the reviewer can be trained to *stay silent*, so an auto-adopted rule is
 * how a real defect class silently stops being flagged. The output here is a diff
 * for review, never a write to the live config.
 *
 * Determinism boundary (analysis R8): this module composes no prose about code.
 * A candidate's `rationale` is either an author/human-authored reason copied
 * verbatim from the dismissal signal, or a fixed, code-owned meta-note about the
 * process ("repeatedly dismissed…"); the module never writes a sentence
 * describing the code under review.
 */

/* -------------------------------------------------------------------------- */
/* Dismissal signals (the mined evidence)                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a finding was rejected. All three are evidence that the finding was
 * unwelcome where it fired:
 *
 *   - `resolved-without-fix`: a bot review thread a human resolved while the
 *     flagged code stayed unchanged — an implicit "not a problem here".
 *   - `thumbs-down-with-reply`: a 👎 reaction (slice-8 sweep) whose follow-up
 *     reply explained the disagreement — an explicit rejection with a reason.
 *   - `correct-pushback`: the author replied disagreeing and was subsequently
 *     shown right (thread closed won't-fix) — the strongest single signal.
 */
export type DismissalSignalKind =
    | "resolved-without-fix"
    | "thumbs-down-with-reply"
    | "correct-pushback";

/** One mined rejection of a specific finding. */
export type DismissalSignal = {
    /** Run the finding was posted in (provenance; optional). */
    runId?: string;
    /** The lens/reviewer source that authored the flagged finding. */
    lens: string;
    /** The file the finding was anchored to. */
    path: string;
    /** How the finding was rejected. */
    kind: DismissalSignalKind;
    /** The finding's Conventional-Comment label, when known (scopes the rule). */
    label?: string;
    /**
     * A human/author-authored reason for the rejection, copied verbatim into the
     * candidate rationale. Never composed here.
     */
    reason?: string;
};

/* -------------------------------------------------------------------------- */
/* The committed suppression config                                           */
/* -------------------------------------------------------------------------- */

/**
 * A committed "do-not-flag-here" rule. A reviewer consults these to suppress a
 * known-unwelcome finding class at a location. This is the shape of each entry in
 * the human-approved config file.
 */
export type DoNotFlagRule = {
    /** The lens/source the suppression applies to. */
    lens: string;
    /** The path (or path glob) the suppression applies to. */
    path_glob: string;
    /** Optional label the suppression is scoped to (omit to cover any label). */
    label?: string;
    /**
     * Why this suppression exists — verbatim author/human reason(s), or a fixed
     * code-owned meta-note. Not prose about the code; provenance for the human
     * approving the rule.
     */
    rationale: string;
    /** How many dismissal signals supported this rule. */
    occurrences: number;
    /** Run ids (or `unknown-run`) the supporting signals came from. */
    provenance: string[];
};

/* -------------------------------------------------------------------------- */
/* Proposal                                                                    */
/* -------------------------------------------------------------------------- */

/** The proposed change to the committed suppression config. */
export type DoNotFlagProposal = {
    /** New rules not already covered by the existing config. */
    candidates: DoNotFlagRule[];
    /** The full config a human would commit (existing rules + candidates). */
    proposedConfig: DoNotFlagRule[];
    /** Unified diff (existing -> proposed) for human review; empty when no change. */
    diff: string;
};

export type ProposeOptions = {
    /**
     * Minimum number of dismissal signals for a (lens, path, label) group before
     * it becomes a candidate. Default `2`: a single dismissal is not enough
     * evidence to teach the reviewer to stay silent — a suppression should rest
     * on a repeated pattern, not one author's one-off call.
     */
    minOccurrences?: number;
    /**
     * Path used in the unified-diff header (`a/<path>` / `b/<path>`). Defaults to
     * the conventional config location so the diff reads like a real change to it.
     */
    configPath?: string;
};

export const DEFAULT_MIN_OCCURRENCES = 2;

/** Conventional location of the committed suppression config. */
export const DEFAULT_CONFIG_PATH = "workflows/review/config/do-not-flag.json";

const CODE_OWNED_RATIONALE =
    "Repeatedly dismissed by authors; candidate suppression for human review.";

const groupKey = (
    lens: string,
    path: string,
    label: string | undefined,
): string =>
    // Label is part of the key so a suppression stays scoped to the label that
    // was dismissed; `\0` cannot appear in the inputs, so it is a safe joiner.
    `${lens}\0${path}\0${label ?? ""}`;

/**
 * Whether an existing rule already covers a candidate (same lens + path, and a
 * label that is equal-or-broader). A rule with no `label` covers any label; a
 * rule with a `label` covers only that label. Used to avoid re-proposing a
 * suppression a human already committed.
 */
export const isCoveredBy = (
    existing: DoNotFlagRule,
    lens: string,
    path: string,
    label: string | undefined,
): boolean => {
    if (existing.lens !== lens || existing.path_glob !== path) {
        return false;
    }
    // A label-less existing rule is broader and covers any candidate label.
    if (existing.label === undefined) {
        return true;
    }
    return existing.label === label;
};

/**
 * Build the candidate suppression rules and the proposed-config diff from mined
 * dismissal signals. Pure and deterministic: identical signals + existing config
 * always yield an identical proposal (candidates are sorted; the diff is a
 * function of the serialised configs).
 *
 * A group of signals for the same (lens, path, label) becomes one candidate when
 * it reaches `minOccurrences` and is not already covered by the existing config.
 * The candidate's `rationale` is the first verbatim author reason in the group,
 * or a fixed meta-note when none carried a reason. NOTHING is applied — the
 * returned `diff`/`proposedConfig` are for a human to commit.
 */
export const proposeDoNotFlagRules = (
    signals: readonly DismissalSignal[],
    existingRules: readonly DoNotFlagRule[] = [],
    options: ProposeOptions = {},
): DoNotFlagProposal => {
    const minOccurrences = Math.max(
        1,
        options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES,
    );
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

    // Group signals by (lens, path, label).
    type Group = {
        lens: string;
        path: string;
        label: string | undefined;
        reasons: string[];
        provenance: string[];
        count: number;
    };
    const groups = new Map<string, Group>();
    for (const signal of signals) {
        const key = groupKey(signal.lens, signal.path, signal.label);
        const group = groups.get(key) ?? {
            lens: signal.lens,
            path: signal.path,
            label: signal.label,
            reasons: [],
            provenance: [],
            count: 0,
        };
        group.count += 1;
        if (signal.reason !== undefined && signal.reason.length > 0) {
            group.reasons.push(signal.reason);
        }
        group.provenance.push(signal.runId ?? "unknown-run");
        groups.set(key, group);
    }

    // Promote qualifying, not-yet-covered groups to candidates.
    const candidates: DoNotFlagRule[] = [];
    for (const group of groups.values()) {
        if (group.count < minOccurrences) {
            continue;
        }
        const alreadyCovered = existingRules.some((rule) =>
            isCoveredBy(rule, group.lens, group.path, group.label),
        );
        if (alreadyCovered) {
            continue;
        }

        // rationale: first verbatim reason, else the code-owned meta-note.
        const rationale = group.reasons[0] ?? CODE_OWNED_RATIONALE;

        const rule: DoNotFlagRule = {
            lens: group.lens,
            path_glob: group.path,
            rationale,
            occurrences: group.count,
            provenance: group.provenance,
        };
        if (group.label !== undefined) {
            rule.label = group.label;
        }
        candidates.push(rule);
    }

    candidates.sort(compareRules);

    const proposedConfig = [...existingRules, ...candidates].sort(compareRules);

    const diff =
        candidates.length === 0
            ? ""
            : unifiedDiff(
                  serializeConfig(existingRules),
                  serializeConfig(proposedConfig),
                  configPath,
              );

    return {candidates, proposedConfig, diff};
};

/** Deterministic ordering of rules: by lens, then path, then label. */
const compareRules = (a: DoNotFlagRule, b: DoNotFlagRule): number => {
    if (a.lens !== b.lens) {
        return a.lens < b.lens ? -1 : 1;
    }
    if (a.path_glob !== b.path_glob) {
        return a.path_glob < b.path_glob ? -1 : 1;
    }
    const al = a.label ?? "";
    const bl = b.label ?? "";
    if (al !== bl) {
        return al < bl ? -1 : 1;
    }
    return 0;
};

/**
 * Serialise a config to the exact text a human would commit: pretty-printed JSON
 * (2-space indent) with a trailing newline. Rules are sorted so the serialisation
 * is stable regardless of input order — the diff then shows only real additions.
 */
export const serializeConfig = (rules: readonly DoNotFlagRule[]): string =>
    `${JSON.stringify([...rules].sort(compareRules), null, 2)}\n`;

/* -------------------------------------------------------------------------- */
/* Unified diff (common-prefix / common-suffix)                               */
/* -------------------------------------------------------------------------- */

/**
 * Produce a git-style unified diff between two texts. Uses a common-prefix /
 * common-suffix reduction: it finds the shared leading and trailing lines and
 * emits the differing middle as one hunk (removed lines then added lines) with up
 * to three lines of surrounding context.
 *
 * This is not a minimal Myers diff, but for this module's changes — appending
 * suppression rules into a JSON array — the changed region is a contiguous middle
 * block, which this handles exactly and deterministically. Returns `""` when the
 * texts are identical.
 */
export const unifiedDiff = (
    before: string,
    after: string,
    path: string,
): string => {
    if (before === after) {
        return "";
    }

    const a = splitLines(before);
    const b = splitLines(after);

    // Common prefix.
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
        prefix += 1;
    }
    // Common suffix (not overlapping the prefix).
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    const context = 3;
    const ctxStart = Math.max(0, prefix - context);
    const aMidEnd = a.length - suffix;
    const bMidEnd = b.length - suffix;
    const aCtxEnd = Math.min(a.length, aMidEnd + context);
    const bCtxEnd = Math.min(b.length, bMidEnd + context);

    const leading = a.slice(ctxStart, prefix);
    const removed = a.slice(prefix, aMidEnd);
    const added = b.slice(prefix, bMidEnd);
    const trailing = a.slice(aMidEnd, aCtxEnd);

    const aStart = a.length === 0 ? 0 : ctxStart + 1;
    const aCount = leading.length + removed.length + trailing.length;
    const bStart = b.length === 0 ? 0 : ctxStart + 1;
    const bCount = leading.length + added.length + (bCtxEnd - bMidEnd);

    const lines: string[] = [
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -${aStart},${aCount} +${bStart},${bCount} @@`,
        ...leading.map((l) => ` ${l}`),
        ...removed.map((l) => `-${l}`),
        ...added.map((l) => `+${l}`),
        ...trailing.map((l) => ` ${l}`),
    ];
    return `${lines.join("\n")}\n`;
};

/**
 * Split text into lines for diffing, dropping a single trailing newline so a
 * file's terminal `\n` is not diffed as an empty final line. An empty string
 * yields no lines.
 */
const splitLines = (text: string): string[] => {
    if (text.length === 0) {
        return [];
    }
    const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
    return normalized.split("\n");
};
