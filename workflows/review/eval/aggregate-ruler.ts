/**
 * The ruler stamp as the aggregate reads it: which matcher, corpus, and
 * runner tool policy produced each pooled report, and the warning when a
 * pool mixes them. Split from aggregate.ts for size; the semantics are
 * documented on ReportProvenance in live-ab-report.ts.
 */

type Stamped = {
    matcher?: string;
    corpusSha?: string;
    toolPolicy?: string;
};

/**
 * Distinct values of one ruler-stamp field. A pool that mixes stamped and
 * unstamped reports lists "unstamped" as a second value, so the mixed-ruler
 * warning fires; an all-unstamped pool stays empty (nothing to compare).
 */
export const stampedValues = (
    samples: readonly Stamped[],
    key: keyof Stamped,
): string[] => {
    const set = new Set(
        samples.flatMap((s) => (s[key] === undefined ? [] : [s[key]])),
    );
    if (set.size > 0 && samples.some((s) => s[key] === undefined)) {
        set.add("unstamped");
    }
    return [...set].sort();
};

/**
 * The ruler line and, when the pool spans more than one value of any stamp
 * field, the mixed-rulers warning. A pre-scope report reads as tools
 * `unscoped`, so a drift pool crossing the read-scope boundary warns the
 * same way an arbiter flip does.
 */
export const rulerLines = (report: {
    matchers: string[];
    corpusShas: string[];
    toolPolicies: string[];
}): string[] => {
    const lines: string[] = [];
    if (report.matchers.length > 0 || report.corpusShas.length > 0) {
        lines.push(
            `Ruler: matcher ${report.matchers.join(", ") || "unstamped"}; ` +
                `corpus ${
                    report.corpusShas
                        .map((sha) => sha.slice(0, 12))
                        .join(", ") || "unstamped"
                }; tools ${report.toolPolicies.join(", ") || "unstamped"}.`,
            "",
        );
    }
    if (
        report.matchers.length > 1 ||
        report.corpusShas.length > 1 ||
        report.toolPolicies.length > 1
    ) {
        lines.push(
            "**WARNING: pooled runs mix rulers (matcher config, corpus " +
                "content, or the runner's tool policy differ); rates are not " +
                "comparable across them.**",
            "",
        );
    }
    return lines;
};
