import {computeRoster, type Roster} from "../lib/dispatch-roster";
import {route, type RouterConfig, type RoutingResult} from "../lib/router";
import {ENABLEABLE_REVIEWERS} from "../lib/routing-config";
import {DEFAULT_MAX_AI_CREDITS} from "../lib/credit-cap";
import type {CorpusCase} from "./corpus/loader";
import type {TierBudgets} from "./runtime-config";

export type LiveExecution = {
    depth: string;
    routing: RoutingResult;
    enabled: string[];
    absent: string[];
    roster: Roster;
};

/** Validate before staging or spend, including opt-ins absent on older arms. */
export const enabledReviewersOf = (corpusCase: CorpusCase): string[] => {
    const raw = corpusCase.routerConfig?.["enabledReviewers"] ?? [];
    if (!Array.isArray(raw) || !raw.every((n) => typeof n === "string")) {
        throw new Error(
            `case "${corpusCase.id}": routerConfig.enabledReviewers must be an array of strings`,
        );
    }
    const unknown = raw.filter(
        (name) => !(ENABLEABLE_REVIEWERS as readonly string[]).includes(name),
    );
    if (unknown.length > 0) {
        throw new Error(
            `case "${corpusCase.id}": unknown enabledReviewers ${unknown.join(
                ", ",
            )}`,
        );
    }
    return ENABLEABLE_REVIEWERS.filter((name) => raw.includes(name));
};

export const liveRouting = (
    corpusCase: CorpusCase,
    agentNames: ReadonlySet<string>,
    options: {tierBudgets?: TierBudgets; disabledReviewers?: string[]},
) => {
    const disabled = options.disabledReviewers ?? [];
    for (const name of disabled) {
        if (!(ENABLEABLE_REVIEWERS as readonly string[]).includes(name)) {
            throw new Error(`unknown disabled reviewer: ${name}`);
        }
    }
    const requested = enabledReviewersOf(corpusCase).filter(
        (name) => !disabled.includes(name),
    );
    const absent = requested.filter((name) => !agentNames.has(name));
    const enabled = requested.filter((name) => agentNames.has(name));
    const config: RouterConfig = {
        generatedRules: [],
        maxAiCredits: DEFAULT_MAX_AI_CREDITS,
        ...(corpusCase.routerConfig as Partial<RouterConfig>),
        ...(options.tierBudgets === undefined
            ? {}
            : {tierBudgets: options.tierBudgets}),
    };
    const routing = route({files: corpusCase.changedFiles}, config);
    return {routing, enabled, absent};
};

export const liveExecution = (
    depth: string,
    routing: ReturnType<typeof liveRouting>,
    hasThreads: boolean,
): LiveExecution => ({
    ...routing,
    depth,
    roster: computeRoster(
        depth,
        {...routing.routing, enabledReviewers: routing.enabled},
        hasThreads,
    ),
});
