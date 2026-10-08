/**
 * Foreign reviewer history: whether the bot's earlier reviews on a PR came
 * from this reviewer or from another one posting as the same bot account.
 *
 * Every install posts as one account, so a PR that moves between installs
 * (a beta and a stable install side by side) or across a major release would
 * otherwise read the other reviewer's reviews, stamp, and threads as its own:
 * it would anchor a reduced re-review on a fingerprint it never took, resolve
 * threads it never opened, and dismiss a block it never raised. The version
 * footer names the release and the install (the workflow file), and staging
 * compares the newest bot review's footer with this run's. A different
 * install, a different major version, or a footer that does not parse makes
 * the history foreign, and the run stages a first encounter: a full review,
 * with the other reviewer's threads left for a human. A minor or patch bump
 * of the same install keeps its history.
 */

export type ReviewerIdentity = {
    major: number;
    install: string;
};

const INSTALL_RE = /^[A-Za-z0-9._-]+$/;

export const installFromWorkflowRef = (
    ref: string | undefined,
): string | null => {
    const match = /\/\.github\/workflows\/([^/@]+?)(?:\.lock)?\.ya?ml@/.exec(
        ref ?? "",
    );
    return match !== null && INSTALL_RE.test(match[1]) ? match[1] : null;
};

const majorOf = (version: string | null | undefined): number | null => {
    const match = /^(\d+)\.\d+\.\d+/.exec(version ?? "");
    return match === null ? null : Number(match[1]);
};

export const currentIdentity = (
    version: string | null | undefined,
    workflowRef: string | undefined,
): ReviewerIdentity | null => {
    const major = majorOf(version);
    const install = installFromWorkflowRef(workflowRef);
    return major === null || install === null ? null : {major, install};
};

const FOOTER_RE =
    /<sub>review-v(\d+)\.\d+\.\d+ \| install ([A-Za-z0-9._-]+) \|[^<]*<\/sub>/g;

export const parseFooterIdentity = (body: string): ReviewerIdentity | null => {
    let identity: ReviewerIdentity | null = null;
    for (const match of body.matchAll(FOOTER_RE)) {
        identity = {major: Number(match[1]), install: match[2]};
    }
    return identity;
};

export const foreignHistoryReason = (
    reviews: readonly {body: string; submittedAt?: string}[],
    current: ReviewerIdentity | null,
): string | null => {
    if (reviews.length === 0) {
        return null;
    }
    const latest = reviews.reduce((newest, review) =>
        newest.submittedAt !== undefined &&
        review.submittedAt !== undefined &&
        review.submittedAt < newest.submittedAt
            ? newest
            : review,
    );
    const prior = parseFooterIdentity(latest.body);
    if (current === null) {
        return "this run's version or install is unknown";
    }
    if (prior === null) {
        return "the latest bot review has no readable version footer";
    }
    if (prior.install !== current.install) {
        return `the latest bot review came from install ${prior.install}, this run is ${current.install}`;
    }
    if (prior.major !== current.major) {
        return `the latest bot review came from major version ${prior.major}, this run is ${current.major}`;
    }
    return null;
};
