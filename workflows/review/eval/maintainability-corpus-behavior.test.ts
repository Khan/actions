import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import ts from "typescript";
import {
    authoredModules,
    caseNamed,
    programFor,
} from "./maintainability-corpus-fixtures";
import {runCase} from "./runner";
import {matchCase} from "./live-match";
import {enabledReviewersOf, liveExecution, liveRouting} from "./live-roster";
import {DEFAULT_TIER_BUDGETS} from "../lib/budgets";

// Executable facts about the authored controls, not a model usefulness audit.
describe("maintainability counterexample contracts", () => {
    it("distinguishes compatible rounding from an error-contract change", () => {
        const positive = authoredModules("maint-search-equivalent");
        const amounts = [1.005, -1.005, 0, 100.4];
        expect(positive("src/invoice").invoiceTotal(amounts)).toBe(
            amounts.reduce(
                (sum, a) =>
                    sum + positive("src/money/decimal").signedMinorUnits(a),
                0,
            ),
        );
        const clean = authoredModules("maint-search-different-errors");
        expect(clean("src/invoice").invoiceTotal([NaN])).toBeNaN();
        expect(() => clean("src/money/strict").checkedMinorUnits(NaN)).toThrow(
            "finite amount required",
        );
    });
    it("keeps preview conversion free of the existing ledger side effect", () => {
        const load = authoredModules("maint-search-different-effects");
        const ledger = load("src/money/ledger");
        expect(load("src/invoice").invoiceTotal([1])).toBe(100);
        expect(ledger.entries).toEqual([]);
        ledger.postedMinorUnits(1);
        expect(ledger.entries).toEqual([100]);
    });
    it("does not conflate a numeric converter with a string parser", () => {
        const {root} = caseNamed("maint-search-different-types");
        const program = programFor(root);
        const checker = program.getTypeChecker();
        const declarationType = (file: string) => {
            const statement = program.getSourceFile(`${root}/${file}`)!
                .statements[0]!;
            if (!ts.isVariableStatement(statement)) {
                throw new Error("expected converter declaration");
            }
            return checker.getTypeAtLocation(
                statement.declarationList.declarations[0]!.name,
            );
        };
        expect(
            checker.isTypeAssignableTo(
                declarationType("src/invoice.ts"),
                declarationType("src/money/text.ts"),
            ),
        ).toBe(false);
    });
    it("demonstrates the predicate mutation and its explicit replacement", () => {
        const old = authoredModules("maint-name-consuming-predicate");
        const brokenQuota = {remaining: 2};
        old("src/preview").preview(brokenQuota);
        expect(brokenQuota.remaining).toBe(1);
        const fixed = authoredModules("maint-name-explicit-reservation");
        const quota = {remaining: 2};
        fixed("src/preview").preview(quota);
        expect(quota.remaining).toBe(2);
        fixed("src/submit").submit(quota);
        expect(quota.remaining).toBe(1);
    });
    it("keeps both implementations of the injected boundary live", () => {
        const load = authoredModules("maint-wrapper-injected");
        expect(load("src/online").online("hello")).toBe("mail:hello");
        expect(load("src/preview").preview("hello")).toBe("preview:hello");
    });
    it("reserves the attachment pair without changing its behavior", () => {
        const old = authoredModules("maint-holdout-attachment-flag");
        const fixed = authoredModules("maint-holdout-attachment-explicit");
        expect(old("src/export").exportAttachment("a\n b")).toBe("a b");
        expect(fixed("src/export").exportAttachment("a\n b")).toBe("a b");
        expect(
            fixed("src/attachments/send").sendAttachment("a\n b", {
                whitespace: "preserve",
            }),
        ).toBe("a\n b");
    });
    it("has a witness for the supposedly dead branch in the reachable control", () => {
        const dead = authoredModules("maint-holdout-retry-dead");
        const live = authoredModules("maint-holdout-retry-reachable");
        const failure = {kind: "permanent", retryable: false};
        expect(dead("src/retry").retryDelay(failure)).toBeNull();
        expect(live("src/retry").retryDelay(failure)).toBe(0);
    });
    it("preserves stock validation and distinct missing-item results", () => {
        for (const name of [
            "maint-stock-lookup-copy",
            "maint-stock-lookup-shared",
        ]) {
            const load = authoredModules(name);
            const catalog = {
                fetch: (key: string) =>
                    key === "tea"
                        ? {onHand: 4, reserved: 1}
                        : key === "empty"
                        ? {onHand: 0, reserved: 0}
                        : undefined,
            };
            expect(
                load("src/stock/units").getAvailableUnits(catalog, " tea "),
            ).toBe(3);
            expect(
                load("src/stock/caption").stockCaption(catalog, " tea "),
            ).toBe("3 available");
            expect(
                load("src/stock/units").getAvailableUnits(catalog, "missing"),
            ).toBe(0);
            expect(
                load("src/stock/caption").stockCaption(catalog, "missing"),
            ).toBe("Unknown item");
            expect(
                load("src/stock/caption").stockCaption(catalog, "empty"),
            ).toBe("Out of stock");
            expect(() =>
                load("src/stock/caption").stockCaption(
                    {fetch: () => ({onHand: NaN, reserved: 0})},
                    "tea",
                ),
            ).toThrow("invalid stock count");
        }
    });
    it("retains both encoding assertions and fresh fixture objects", () => {
        for (const name of [
            "maint-encoding-fixture-copy",
            "maint-encoding-fixture-shared",
        ]) {
            const checks = authoredModules(name)("src/encoding/checks");
            expect(() => checks.verifyPlainRows()).not.toThrow();
            expect(() => checks.verifyEnvelopeRows()).not.toThrow();
        }
        const fixture = authoredModules("maint-encoding-fixture-shared")(
            "src/encoding/fixtures",
        ).rowFixture;
        const first = fixture();
        first[0].readings[0].value = 99;
        expect(fixture()[0].readings[0].value).toBe(12);
    });
    it("keeps the pre-existing duplication identical across the diff", () => {
        const {entry, root} = caseNamed("maint-untouched-debt");
        const before = readFileSync(
            `${entry.casePath}/before/src/legacy.ts.txt`,
            "utf8",
        );
        const after = readFileSync(`${root}/src/legacy.ts`, "utf8");
        expect(after.split("\n").slice(0, 2)).toEqual(
            before.split("\n").slice(0, 2),
        );
        expect(after).not.toBe(before);
    });
});

describe("mixed reviewer pressure references", () => {
    it("preserves collapsed useful catches while the three inline slots fill", async () => {
        const {corpusCase} = caseNamed("maint-mixed-export");
        const result = runCase(corpusCase, {posting: {depth: "full"}});
        expect(result.plannedReview.comments).toHaveLength(4);
        expect(result.postedCandidates).toHaveLength(5);
        const matched = await matchCase(corpusCase, result);
        expect(matched.caught).toHaveLength(5);
        expect(matched.missed).toEqual([]);
    });
    it("separates cap recovery from maintainability and credit shedding", () => {
        const fullCase = caseNamed("maint-mixed-export").corpusCase;
        const names = new Set(enabledReviewersOf(fullCase));
        const current = DEFAULT_TIER_BUDGETS;
        const old = {
            ...current,
            low: {...current.low, maxReviewerInvocations: 8},
        };
        const rosterFor = (
            name: string,
            tierBudgets = current,
            disabledReviewers: string[] = [],
        ) =>
            liveExecution(
                "full",
                liveRouting(caseNamed(name).corpusCase, names, {
                    tierBudgets,
                    disabledReviewers,
                }),
                false,
            ).roster;
        const legacy = rosterFor("maint-mixed-export", old, [
            "maintainability",
        ]);
        const recovered = rosterFor("maint-mixed-export", current, [
            "maintainability",
        ]);
        const enabled = rosterFor("maint-mixed-export");
        expect(legacy.shed.map((s) => s.name)).toContain("documentation");
        expect(recovered.shed.map((s) => s.name)).not.toContain(
            "documentation",
        );
        expect(enabled.shed.map((s) => s.name)).toContain("documentation");
        expect(enabled.finders).toContain("maintainability");
        const tight = rosterFor("maint-mixed-export-tight-credit");
        expect(tight.finders).not.toContain("maintainability");
        expect(tight.shed.map((s) => s.name)).toContain("maintainability");
    });
});
