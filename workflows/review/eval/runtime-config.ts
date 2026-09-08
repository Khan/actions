import ts from "typescript";

import type {RouterConfig} from "../lib/router";
import {RISK_TIERS} from "../lib/routing-config";

export type TierBudgets = NonNullable<RouterConfig["tierBudgets"]>;

/** Read the arm's literal budget table without executing code from its ref. */
export const extractTierBudgets = (source: string): TierBudgets => {
    const file = ts.createSourceFile(
        "budgets.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    let initializer: ts.Expression | undefined;
    for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === "DEFAULT_TIER_BUDGETS"
            ) {
                initializer = declaration.initializer;
            }
        }
    }
    const literal = (node: ts.Expression): unknown => {
        if (ts.isStringLiteral(node)) {
            return node.text;
        }
        if (ts.isNumericLiteral(node)) {
            return Number(node.text);
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) {
            return true;
        }
        if (node.kind === ts.SyntaxKind.FalseKeyword) {
            return false;
        }
        if (ts.isObjectLiteralExpression(node)) {
            const entries = node.properties.map((property) => {
                if (
                    !ts.isPropertyAssignment(property) ||
                    !(
                        ts.isIdentifier(property.name) ||
                        ts.isStringLiteral(property.name)
                    )
                ) {
                    throw new Error(
                        "budget table must contain literal properties only",
                    );
                }
                return [
                    property.name.text,
                    literal(property.initializer),
                ] as const;
            });
            if (new Set(entries.map(([key]) => key)).size !== entries.length) {
                throw new Error("duplicate budget property");
            }
            return Object.fromEntries(entries);
        }
        throw new Error("budget table must contain literals only");
    };
    if (initializer === undefined) {
        throw new Error("DEFAULT_TIER_BUDGETS not found");
    }
    const raw = literal(initializer) as Record<string, Record<string, unknown>>;
    for (const tier of RISK_TIERS) {
        const budget = raw[tier];
        if (budget?.tier !== tier || budget.floored !== false) {
            throw new Error(`invalid ${tier} budget identity`);
        }
        for (const key of [
            "maxReviewerInvocations",
            "maxToolCallsPerFinding",
            "maxTotalToolCalls",
            "maxWallClockMinutes",
            "maxUsd",
        ]) {
            const value = budget[key];
            if (
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                value <= 0 ||
                (key !== "maxUsd" && !Number.isInteger(value))
            ) {
                throw new Error(`invalid ${tier}.${key}`);
            }
        }
    }
    return raw as unknown as TierBudgets;
};

export type ReportProvenance = {
    /**
     * Matcher configuration: `deterministic-v2` or
     * `deterministic-v2+arbiter` (v1, unsuffixed, predates the lens
     * tie-break and the leftover buckets).
     */
    matcher: string;
    /** Content hash of the loaded corpus cases this run was scored against. */
    corpusSha: string;
    caseCount: number;
    /**
     * What the runner let reviewers reach (`READ_TOOL_POLICY` in
     * read-scope.ts). Absent on reports before the read scope, which the
     * aggregate reads as `unscoped`: those reviewers had every default tool
     * and could read the corpus, so their rates are a different instrument.
     */
    toolPolicy?: string;
};

export type ArmRuntime = {
    tierBudgets: TierBudgets;
    disabledReviewers: string[];
    reReviewMode: string;
};
