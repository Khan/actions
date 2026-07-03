import {describe, it, expect} from "vitest";

import {
    ALWAYS_ON_LENSES,
    computeRunBudget,
    DEFAULT_MISROUTED_FLOOR_TIER,
    DEFAULT_TIER_BUDGETS,
    isGenerated,
    matchesGlob,
    parseGitattributesGenerated,
    parseReviewers,
    patternSpecificity,
    RISK_TIERS,
    route,
    SPECIALIST_LENSES,
    teamSlug,
    type ChangedFile,
    type RouterConfig,
    type RunBudget,
} from "./router.ts";

/**
 * Router unit tests (TASK-3-4). `route` and its helpers are pure, deterministic
 * TypeScript (plan §8.6: the core never calls a model), so these tests pin the
 * five AC axes over fixtures -- classification, path->lens, tier, budget
 * scaling, and the misrouted floor -- plus the reviewer-mapper subsumption
 * (R12: team ownership now in code) and the glob/config parsers the routing is
 * built on. No I/O and no network: the CLI does the file read; the core takes
 * content/structure in and returns structure out.
 */

// A source file helper (status defaults to "modified"; the deterministic core
// only branches on status where a rule opts in, so most fixtures don't care).
const file = (
    path: string,
    status: ChangedFile["status"] = "modified",
): ChangedFile => ({
    path,
    status,
});

// Minimal config: no generated globs, DEFAULT_* lens/risk rules, no REVIEWERS.
const baseConfig: RouterConfig = {generatedPatterns: []};

/* -------------------------------------------------------------------------- */
/* Glob matching                                                              */
/* -------------------------------------------------------------------------- */

describe("matchesGlob", () => {
    it("matches a basename-only pattern in any directory", () => {
        expect(matchesGlob("Dockerfile", "Dockerfile")).toBe(true);
        expect(matchesGlob("services/api/Dockerfile", "Dockerfile")).toBe(true);
        expect(matchesGlob("services/api/Dockerfile.dev", "Dockerfile")).toBe(
            false,
        );
    });

    it("does not let a single star cross a slash", () => {
        expect(matchesGlob("a/c.ts", "a/*.ts")).toBe(true);
        expect(matchesGlob("a/b/c.ts", "a/*.ts")).toBe(false);
    });

    it("lets a double star span zero or more path segments", () => {
        expect(matchesGlob("a/c.ts", "a/**/*.ts")).toBe(true);
        expect(matchesGlob("a/b/c.ts", "a/**/*.ts")).toBe(true);
        expect(
            matchesGlob("db/migrations/0001_init.sql", "**/migrations/**"),
        ).toBe(true);
    });

    it("treats a trailing slash as a directory prefix", () => {
        expect(matchesGlob("src/auth", "src/auth/")).toBe(true);
        expect(matchesGlob("src/auth/login.ts", "src/auth/")).toBe(true);
        expect(matchesGlob("src/authz.ts", "src/auth/")).toBe(false);
    });
});

describe("patternSpecificity", () => {
    it("ranks a more literal / deeper pattern above a broader one", () => {
        expect(patternSpecificity("src/auth/**")).toBeGreaterThan(
            patternSpecificity("src/**"),
        );
        expect(patternSpecificity("src/auth/login.ts")).toBeGreaterThan(
            patternSpecificity("src/auth/**"),
        );
    });
});

/* -------------------------------------------------------------------------- */
/* Config parsers                                                             */
/* -------------------------------------------------------------------------- */

describe("parseGitattributesGenerated", () => {
    it("collects linguist-generated patterns and honours negation", () => {
        const content = [
            "# comment",
            "",
            "dist/** linguist-generated=true",
            "vendor/** linguist-generated",
            "generated/keep.ts -linguist-generated",
            "src/*.ts text",
            "other/*.js linguist-generated=false",
        ].join("\n");
        expect(parseGitattributesGenerated(content)).toEqual([
            "dist/**",
            "vendor/**",
        ]);
    });
});

describe("teamSlug", () => {
    it("strips @, org prefix, trailing !, and lowercases", () => {
        expect(teamSlug("@Khan/Security!")).toBe("security");
        expect(teamSlug("@Org/Sub-Team")).toBe("sub-team");
        expect(teamSlug("web")).toBe("web");
    });
});

describe("parseReviewers", () => {
    it("parses ownership rules, skipping comments and section headers", () => {
        const content = [
            "[ON PULL REQUEST]",
            "# owners",
            "",
            "src/auth/ @Khan/Security!",
            "src/ @Khan/Web @Khan/Infra",
        ].join("\n");
        expect(parseReviewers(content)).toEqual([
            {pattern: "src/auth/", teams: ["security"]},
            {pattern: "src/", teams: ["web", "infra"]},
        ]);
    });
});

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

describe("route: classification", () => {
    it("marks linguist-generated files generated with no lenses/teams/tier", () => {
        const generatedPatterns = parseGitattributesGenerated(
            "dist/** linguist-generated=true",
        );
        expect(isGenerated("dist/bundle.js", generatedPatterns)).toBe(true);

        const result = route(
            {files: [file("dist/bundle.js")]},
            {...baseConfig, generatedPatterns},
        );
        expect(result.perFile[0]).toMatchObject({
            path: "dist/bundle.js",
            classification: "generated",
            tier: "trivial",
            tierPending: false,
            lenses: [],
            teams: [],
        });
        // An all-generated PR touches no source, so it is not "misrouted".
        expect(result.misrouted).toBe(false);
        expect(result.lensesToSpawn).toEqual([]);
    });

    it("marks a non-generated file as source", () => {
        const result = route({files: [file("src/app.ts")]}, baseConfig);
        expect(result.perFile[0].classification).toBe("source");
    });
});

/* -------------------------------------------------------------------------- */
/* Path -> lens                                                               */
/* -------------------------------------------------------------------------- */

describe("route: path -> lens", () => {
    it("unions the lenses of every matching rule for a file", () => {
        const result = route({files: [file("proto/user.proto")]}, baseConfig);
        expect(result.perFile[0].lenses).toEqual([
            "api-federation-compat",
            "cross-deploy-serialization",
        ]);
    });

    it("dedupes lensesToSpawn across files in canonical KNOWN_LENSES order", () => {
        const result = route(
            {
                files: [
                    file("db/migrations/0001_init.sql"),
                    file("src/auth/login.ts"),
                    file("infra/main.tf"),
                ],
            },
            baseConfig,
        );
        // security-auth (0) < data-migrations (4) < deploy-infra-config (8).
        expect(result.lensesToSpawn).toEqual([
            "security-auth",
            "data-migrations",
            "deploy-infra-config",
        ]);
    });

    it("never spawns an always-on lens as a specialist", () => {
        expect(SPECIALIST_LENSES).toHaveLength(11);
        for (const lens of ALWAYS_ON_LENSES) {
            expect(SPECIALIST_LENSES).not.toContain(lens);
        }
        const result = route({files: [file("src/auth/login.ts")]}, baseConfig);
        for (const lens of ALWAYS_ON_LENSES) {
            expect(result.lensesToSpawn).not.toContain(lens);
        }
    });
});

/* -------------------------------------------------------------------------- */
/* Tier                                                                       */
/* -------------------------------------------------------------------------- */

describe("route: tier", () => {
    it("uses the default tier for a source file matching no risk rule", () => {
        const result = route({files: [file("src/app.ts")]}, baseConfig);
        expect(result.perFileTier["src/app.ts"]).toBe("low");
    });

    it("respects an explicit defaultTier override", () => {
        const result = route(
            {files: [file("src/app.ts")]},
            {...baseConfig, defaultTier: "medium"},
        );
        expect(result.perFileTier["src/app.ts"]).toBe("medium");
    });

    it("takes the highest tier among matching rules", () => {
        // A .sql migration matches two high rules -> high.
        const result = route(
            {files: [file("db/migrations/0001_init.sql")]},
            baseConfig,
        );
        expect(result.perFileTier["db/migrations/0001_init.sql"]).toBe("high");
    });

    it("defers a diff-direction-dependent file with a conservative tier now", () => {
        const result = route({files: [file("src/auth/login.ts")]}, baseConfig);
        const routing = result.perFile[0];
        expect(routing.tierPending).toBe(true);
        // Conservative: never understate the budget while awaiting resolution.
        expect(routing.tier).toBe("high");
        expect(result.pendingRiskQuestions).toEqual([
            {
                path: "src/auth/login.ts",
                kind: "diff-direction-dependent",
                candidateTiers: ["high"],
            },
        ]);
    });

    it("lets a second-pass resolvedTier win and clears the pending question", () => {
        const result = route(
            {
                files: [file("src/auth/login.ts")],
                resolvedTiers: {"src/auth/login.ts": "low"},
            },
            baseConfig,
        );
        expect(result.perFile[0].tier).toBe("low");
        expect(result.perFile[0].tierPending).toBe(false);
        expect(result.pendingRiskQuestions).toEqual([]);
        expect(result.runBudget.tier).toBe("low");
    });
});

/* -------------------------------------------------------------------------- */
/* Budget scaling                                                             */
/* -------------------------------------------------------------------------- */

describe("computeRunBudget: scaling", () => {
    const numericFields: (keyof RunBudget)[] = [
        "maxReviewerInvocations",
        "maxToolCallsPerFinding",
        "maxTotalToolCalls",
        "maxWallClockMinutes",
        "maxUsd",
    ];

    it("scales every budget field monotonically with tier", () => {
        const budgets = RISK_TIERS.map((tier) =>
            computeRunBudget(tier, false, baseConfig),
        );
        for (let i = 1; i < budgets.length; i++) {
            for (const f of numericFields) {
                expect(budgets[i][f] as number).toBeGreaterThanOrEqual(
                    budgets[i - 1][f] as number,
                );
            }
        }
    });

    it("selects the budget of the given (highest touched) tier", () => {
        const budget = computeRunBudget("medium", false, baseConfig);
        expect(budget.tier).toBe("medium");
        expect(budget.floored).toBe(false);
        expect(budget.maxReviewerInvocations).toBe(
            DEFAULT_TIER_BUDGETS.medium.maxReviewerInvocations,
        );
    });

    it("scales the run budget by the highest touched tier across files", () => {
        // A trivial doc + a high migration -> the run budget is high.
        const result = route(
            {
                files: [file("README.md"), file("db/migrations/0001.sql")],
            },
            baseConfig,
        );
        expect(result.runBudget.tier).toBe("high");
        expect(result.runBudget.floored).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */
/* Misrouted floor                                                            */
/* -------------------------------------------------------------------------- */

describe("misrouted floor", () => {
    it("floors a misrouted PR up to the floor tier (computeRunBudget)", () => {
        expect(DEFAULT_MISROUTED_FLOOR_TIER).toBe("low");
        const budget = computeRunBudget("trivial", true, baseConfig);
        expect(budget.tier).toBe("low");
        expect(budget.floored).toBe(true);
    });

    it("does not lower an already-higher touched tier to the floor", () => {
        const budget = computeRunBudget("high", true, baseConfig);
        expect(budget.tier).toBe("high");
        expect(budget.floored).toBe(false);
    });

    it("flags a docs-only PR as misrouted and applies the floor via route", () => {
        // README.md is a trivial source file that no specialist lens claims.
        const result = route({files: [file("README.md")]}, baseConfig);
        expect(result.misrouted).toBe(true);
        expect(result.lensesToSpawn).toEqual([]);
        expect(result.runBudget.tier).toBe("low");
        expect(result.runBudget.floored).toBe(true);
    });

    it("is not misrouted when at least one specialist lens matched", () => {
        const result = route(
            {files: [file("db/migrations/0001.sql")]},
            baseConfig,
        );
        expect(result.misrouted).toBe(false);
        expect(result.runBudget.floored).toBe(false);
    });

    it("is not misrouted for an empty changed-file list", () => {
        const result = route({files: []}, baseConfig);
        expect(result.misrouted).toBe(false);
        expect(result.lensesToSpawn).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- */
/* Teams (reviewer-mapper subsumption, R12)                                   */
/* -------------------------------------------------------------------------- */

describe("route: team ownership (subsumes reviewer-mapper)", () => {
    const reviewerRules = parseReviewers(
        [
            "src/auth/ @Khan/Security",
            "src/ @Khan/Web",
            "infra/ @Khan/Infra",
        ].join("\n"),
    );

    it("picks the most specific matching REVIEWERS rule per file", () => {
        const result = route(
            {files: [file("src/auth/login.ts")]},
            {...baseConfig, reviewerRules},
        );
        // src/auth/ wins over the broader src/ rule.
        expect(result.perFile[0].teams).toEqual(["security"]);
    });

    it("returns the sorted union of owning teams and a file-count fallback rank", () => {
        const result = route(
            {
                files: [
                    file("src/auth/login.ts"),
                    file("src/pages/home.ts"),
                    file("src/pages/about.ts"),
                    file("infra/main.tf"),
                ],
            },
            {...baseConfig, reviewerRules},
        );
        expect(result.teams).toEqual(["infra", "security", "web"]);
        // web owns 2 files, security + infra own 1 each; ties break alphabetically.
        expect(result.fallbackTeams).toEqual([
            {team: "web", files: 2},
            {team: "infra", files: 1},
            {team: "security", files: 1},
        ]);
    });

    it("assigns no team to a file matching no REVIEWERS rule", () => {
        const result = route(
            {files: [file("docs/readme-notes.txt")]},
            {...baseConfig, reviewerRules},
        );
        expect(result.perFile[0].teams).toEqual([]);
        expect(result.teams).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe("route: determinism", () => {
    it("returns deep-equal results for the same input + config", () => {
        const files = [
            file("src/auth/login.ts"),
            file("db/migrations/0001.sql"),
            file("README.md"),
        ];
        const a = route({files}, baseConfig);
        const b = route({files}, baseConfig);
        expect(a).toEqual(b);
    });
});
