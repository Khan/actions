import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import {describe, expect, it} from "vitest";

import {extractAgents} from "./agent-extract";
import {review} from "./corpus/clean/clean-maintainability-documented-retry/tree/src/main";
import {placeOrder} from "./corpus/clean/clean-maintainability-transaction-wrapper/tree/src/handler";
import type {Database} from "./corpus/clean/clean-maintainability-transaction-wrapper/tree/src/database";
import {loadCorpus} from "./corpus/loader";

const fixture = (name: string, path: string): string =>
    readFileSync(
        resolve(__dirname, "corpus/clean", name, "tree", path),
        "utf8",
    );

// These tests establish the controls' premises, not the model's precision.
describe("maintainability reader-cost controls", () => {
    it("has three live clean controls with explicit false-flag specs", () => {
        const cases = loadCorpus().filter((c) =>
            c.tags.includes("reader-cost"),
        );
        expect(cases.map((c) => c.id).sort()).toEqual([
            "clean-maintainability-documented-retry",
            "clean-maintainability-small-adapter",
            "clean-maintainability-transaction-wrapper",
        ]);
        for (const c of cases) {
            expect(c.category).toBe("clean");
            expect(c.tags).toContain("live");
            expect(c.findings).toEqual([]);
            expect(c.live?.mustNotFlagSpecs).toHaveLength(1);
        }
    });

    it("keeps the small adapters identical rather than hiding a behavior difference", () => {
        const initializer = (
            path: string,
            name: string,
        ): string | undefined => {
            const source = ts.createSourceFile(
                path,
                fixture("clean-maintainability-small-adapter", path),
                ts.ScriptTarget.ES2022,
                true,
            );
            return source.statements
                .filter(ts.isVariableStatement)
                .flatMap((statement) => statement.declarationList.declarations)
                .find(
                    (declaration) => declaration.name.getText(source) === name,
                )
                ?.initializer?.getText(source);
        };
        const exported = initializer("src/commands/export.ts", "EXPORT_FS");
        expect(exported).toBeDefined();
        expect(exported).toBe(
            initializer("src/commands/preview.ts", "PREVIEW_FS"),
        );
    });

    it("exposes the retry at the callback contract and call site", () => {
        const source = fixture(
            "clean-maintainability-documented-retry",
            "src/review.ts",
        );
        expect(source).toContain(
            "The returned promise includes that paid retry",
        );
        expect(source).toContain(
            "parse: (output: string) => Promise<ReviewResult>",
        );
        expect(source).toContain("Allow one corrective model call");
        expect(source).toContain("return io.parse(output)");
    });

    it("really redispatches and stages the replacement reply", async () => {
        const calls: string[] = [];
        const staged: string[] = [];
        const result = await review(
            async (instruction) => {
                calls.push(instruction);
                return calls.length === 1
                    ? "malformed"
                    : '{"findings":["check the quota"]}';
            },
            (output) => staged.push(output),
        );
        expect(calls).toHaveLength(2);
        expect(staged).toEqual([
            "malformed",
            '{"findings":["check the quota"]}',
        ]);
        expect(result).toEqual({findings: ["check the quota"]});
    });

    it("doesn't dispatch again after the one corrective attempt", async () => {
        const staged: string[] = [];
        await expect(
            review(
                async () => "still malformed",
                (output) => staged.push(output),
            ),
        ).rejects.toThrow();
        expect(staged).toEqual(["still malformed", "still malformed"]);
    });

    it.each([false, true])(
        "keeps both order writes inside the transaction (reservation fails: %s)",
        async (failReservation) => {
            const events: string[] = [];
            const db: Database = {
                transaction: async (work) => {
                    events.push("begin");
                    try {
                        await work({
                            insertOrder: async () => {
                                events.push("insert");
                            },
                            reserveStock: async () => {
                                events.push("reserve");
                                if (failReservation) {
                                    throw new Error("out of stock");
                                }
                            },
                        });
                        events.push("commit");
                    } catch (error) {
                        events.push("rollback");
                        throw error;
                    }
                },
            };
            const result = placeOrder(db, {
                id: "order-1",
                sku: "book",
                quantity: 1,
            });
            if (failReservation) {
                await expect(result).rejects.toThrow("out of stock");
            } else {
                await expect(result).resolves.toEqual({id: "order-1"});
            }
            expect(events).toEqual([
                "begin",
                "insert",
                "reserve",
                failReservation ? "rollback" : "commit",
            ]);
        },
    );

    it("retains the useful wrapper's single production caller", () => {
        const name = "clean-maintainability-transaction-wrapper";
        const caller = fixture(name, "src/handler.ts");
        expect(caller.match(/\bstoreOrder\(/g)).toHaveLength(1);
        const wrapper = fixture(name, "src/store.ts");
        expect(wrapper).toContain("db.transaction(async (tx)");
        expect(wrapper).toContain("await tx.insertOrder(order)");
        expect(wrapper).toContain(
            "await tx.reserveStock(order.sku, order.quantity)",
        );
    });
});

describe("maintainability prompt contract", () => {
    it("requires task-specific cost and checks context before recommending cleanup", () => {
        const agents = extractAgents(
            readFileSync(resolve(__dirname, "../review.md"), "utf8"),
        );
        const prompt = agents.get("maintainability")!.prompt;
        expect(prompt).toContain("A finding needs a concrete maintenance task");
        expect(prompt).toContain(
            "The proposed fix must reduce the work of that task",
        );
        expect(prompt).toContain("Read the signature,");
        expect(prompt).toContain(
            "nearby contract, and caller before claiming a surprise",
        );
        expect(prompt).toContain(
            "One caller is a search clue, not evidence of a defect",
        );
        expect(prompt).toContain(
            "quote a shared contract or parity requirement",
        );
        expect(prompt).toContain(
            "A behavioral violation belongs to correctness",
        );
        expect(prompt).toContain(
            "at most two per file, at most five per review",
        );
        const validator = agents.get("claim-validator")!.prompt;
        expect(validator).toContain("Verify the named maintenance task");
        expect(validator).toContain("One caller alone proves nothing");
    });
});
