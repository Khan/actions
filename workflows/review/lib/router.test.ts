import {describe, it, expect} from "vitest";

import {
    clampBudgetToCreditCap,
    DEFAULT_MAX_AI_CREDITS,
    resolveCreditCap,
} from "./credit-cap";

import {
    ALWAYS_ON_LENSES,
    computeRunBudget,
    DEFAULT_MISROUTED_FLOOR_TIER,
    DEFAULT_TIER_BUDGETS,
    isGenerated,
    matchesGlob,
    parseGitattributesGenerated,
    parseReviewers,
    parseRoutingConfig,
    patternSpecificity,
    RISK_TIERS,
    route,
    ROUTING_CONFIG_PATH,
    runCli,
    SPECIALIST_LENSES,
    teamSlug,
    tierFromDisplay,
    toRoutingJson,
    type ChangedFile,
    type RouterConfig,
    type RunBudget,
} from "./router.ts";

/**
 * Router unit tests. `route` and its helpers are pure, deterministic
 * TypeScript (the core never calls a model), so these tests pin the
 * five axes over fixtures -- classification, path->lens, tier, budget
 * scaling, and the misrouted floor -- plus the reviewer-mapper subsumption
 * (team ownership now in code) and the glob/config parsers the routing is
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

// Explicit rule fixtures. The router ships NO default rules (a repo's routing
// map lives in its own .github/aw/review/ROUTING file), so the tests supply
// the rules they exercise, shaped like a typical consumer config.
const baseConfig: RouterConfig = {
    generatedPatterns: [],
    lensRules: [
        {pattern: "**/*.sql", lenses: ["data-migrations"]},
        {pattern: "**/migrations/**", lenses: ["data-migrations"]},
        {
            pattern: "**/*.proto",
            lenses: ["api-federation-compat", "cross-deploy-serialization"],
        },
        {pattern: "**/auth/**", lenses: ["security-auth"]},
        {pattern: "**/*.tf", lenses: ["deploy-infra-config"]},
    ],
    riskRules: [
        {pattern: "**/migrations/**", tier: "high"},
        {pattern: "**/*.sql", tier: "high"},
        {pattern: "**/auth/**", tier: "high", diffDirectionDependent: true},
        {pattern: "**/*.md", tier: "trivial"},
    ],
};

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

    it("takes the tier of the last matching rule in file order", () => {
        // A .sql migration matches two high rules -> high.
        const result = route(
            {files: [file("db/migrations/0001_init.sql")]},
            baseConfig,
        );
        expect(result.perFileTier["db/migrations/0001_init.sql"]).toBe("high");
    });

    it("lets a later exception rule override an earlier broad rule", () => {
        // gitignore/CODEOWNERS-style: broad rule first, exception after.
        const config = {
            ...baseConfig,
            riskRules: [
                {pattern: "services/**", tier: "high" as const},
                {pattern: "services/**/testdata/**", tier: "trivial" as const},
            ],
        };
        const result = route(
            {
                files: [
                    file("services/payments/handler.go"),
                    file("services/payments/testdata/fixtures.json"),
                ],
            },
            config,
        );
        expect(result.perFileTier["services/payments/handler.go"]).toBe("high");
        expect(
            result.perFileTier["services/payments/testdata/fixtures.json"],
        ).toBe("trivial");
    });

    it("ignores an earlier rule's direction-dependence when a later rule wins", () => {
        // The exception overrides the whole decision, pending included.
        const config = {
            ...baseConfig,
            riskRules: [
                {
                    pattern: "pkg/auth/**",
                    tier: "high" as const,
                    diffDirectionDependent: true,
                },
                {pattern: "pkg/auth/**/testdata/**", tier: "trivial" as const},
            ],
        };
        const result = route(
            {files: [file("pkg/auth/checks/testdata/tokens.json")]},
            config,
        );
        expect(result.perFile[0].tier).toBe("trivial");
        expect(result.perFile[0].tierPending).toBe(false);
        expect(result.pendingRiskQuestions).toEqual([]);
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

describe("clampBudgetToCreditCap", () => {
    it("records but does not clamp a cap that covers the tier budget", () => {
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 2500);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            effectiveCreditCap: 2500,
        });
        expect(clamped.capClamped).toBeUndefined();
    });

    it("scales every soft target to the reserve-adjusted cap, not the cap", () => {
        // The budget-shed incident shape: the high tier ($10) planned inside a
        // 400-credit ($4) cap, so the run died at the api-proxy mid-validation.
        // The soft dollar target is 75% of the cap (the landing reserve): the
        // acceptance re-run showed a soft target equal to the hard cap still
        // dies at it (416/400), because spend is unobservable mid-run and
        // in-flight work bills after the last observable checkpoint.
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 400);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            maxReviewerInvocations: 3, // floor(12 * 0.3)
            maxToolCallsPerFinding: 2, // floor(8 * 0.3)
            maxTotalToolCalls: 36, // floor(120 * 0.3)
            maxWallClockMinutes: 6, // floor(20 * 0.3)
            maxUsd: 3, // 4 * 0.75
            effectiveCreditCap: 400,
            capClamped: true,
        });
    });

    it("leaves a tier alone only when its target clears the reserve", () => {
        // $10 tier under a 1400-credit ($14) cap: 75% of the cap is $10.50,
        // above the tier's own $10 target, so nothing needs resizing.
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 1400);
        expect(clamped).toEqual({
            ...DEFAULT_TIER_BUDGETS.high,
            effectiveCreditCap: 1400,
        });
        // $10 tier under a 1200-credit ($12) cap: the reserve-adjusted target
        // ($9) is below the tier's $10, so the clamp engages.
        const tight = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 1200);
        expect(tight.capClamped).toBe(true);
        expect(tight.maxUsd).toBe(9);
    });

    it("never drops below the trivial tier's floors", () => {
        const floor = DEFAULT_TIER_BUDGETS.trivial;
        const clamped = clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 10);
        expect(clamped.maxReviewerInvocations).toBe(
            floor.maxReviewerInvocations,
        );
        expect(clamped.maxToolCallsPerFinding).toBe(
            floor.maxToolCallsPerFinding,
        );
        expect(clamped.maxTotalToolCalls).toBe(floor.maxTotalToolCalls);
        expect(clamped.maxWallClockMinutes).toBe(floor.maxWallClockMinutes);
        // The dollar target has no floor: a floor above the cap would defeat
        // the cap. 75% of the $0.10 cap, within float precision.
        expect(clamped.maxUsd).toBeCloseTo(0.075, 10);
        expect(clamped.capClamped).toBe(true);
    });

    it("treats a zero or negative cap as explicitly uncapped", () => {
        expect(clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, -1)).toEqual(
            DEFAULT_TIER_BUDGETS.high,
        );
        expect(clampBudgetToCreditCap(DEFAULT_TIER_BUDGETS.high, 0)).toEqual(
            DEFAULT_TIER_BUDGETS.high,
        );
    });

    it("applies through computeRunBudget via config.maxAiCredits", () => {
        const budget = computeRunBudget("high", false, {
            ...baseConfig,
            maxAiCredits: 400,
        });
        expect(budget.tier).toBe("high");
        expect(budget.capClamped).toBe(true);
        expect(budget.maxUsd).toBe(3);
    });
});

describe("resolveCreditCap", () => {
    const noFs = {
        existsSync: (): boolean => false,
        readFileSync: (): string => {
            throw new Error("unexpected read");
        },
    };

    it("prefers the REVIEW_MAX_AI_CREDITS frontmatter mirror", () => {
        expect(
            resolveCreditCap(
                {REVIEW_MAX_AI_CREDITS: "2500", GH_AW_MAX_AI_CREDITS: "400"},
                noFs,
            ),
        ).toBe(2500);
    });

    it("falls back to GH_AW_MAX_AI_CREDITS", () => {
        expect(resolveCreditCap({GH_AW_MAX_AI_CREDITS: "400"}, noFs)).toBe(400);
    });

    it("ignores non-numeric and empty env values and keeps looking", () => {
        expect(
            resolveCreditCap(
                {REVIEW_MAX_AI_CREDITS: "lots", GH_AW_MAX_AI_CREDITS: ""},
                noFs,
            ),
        ).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("reads apiProxy.maxAiCredits from a visible awf config", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 400},
            }),
        });
        expect(resolveCreditCap({}, fs)).toBe(400);
    });

    it("prefers the RUNNER_TEMP awf config over the /tmp fallback", () => {
        const {fs} = fakeFs({
            "/rt/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 250},
            }),
            "/tmp/gh-aw/awf-config.json": JSON.stringify({
                apiProxy: {maxAiCredits: 400},
            }),
        });
        expect(resolveCreditCap({RUNNER_TEMP: "/rt"}, fs)).toBe(250);
    });

    it("survives an unparseable awf config and falls through", () => {
        const {fs} = fakeFs({
            "/tmp/gh-aw/awf-config.json": "not json",
        });
        expect(resolveCreditCap({}, fs)).toBe(DEFAULT_MAX_AI_CREDITS);
    });

    it("defaults to gh-aw's baked-in cap when nothing is discoverable", () => {
        expect(resolveCreditCap({}, noFs)).toBe(DEFAULT_MAX_AI_CREDITS);
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
/* Teams (reviewer-mapper subsumption)                                        */
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

/* -------------------------------------------------------------------------- */
/* tierFromDisplay (I/O casing bridge)                                        */
/* -------------------------------------------------------------------------- */

describe("tierFromDisplay", () => {
    it("accepts both the display and lowercase casings", () => {
        expect(tierFromDisplay("High")).toBe("high");
        expect(tierFromDisplay("high")).toBe("high");
        expect(tierFromDisplay("Trivial")).toBe("trivial");
        expect(tierFromDisplay("medium")).toBe("medium");
    });

    it("falls back to low for an unknown value", () => {
        expect(tierFromDisplay("bogus")).toBe("low");
        expect(tierFromDisplay("")).toBe("low");
    });
});

/* -------------------------------------------------------------------------- */
/* toRoutingJson (adapt RoutingResult -> the review.md routing.json contract) */
/* -------------------------------------------------------------------------- */

describe("toRoutingJson", () => {
    it("bridges to the routing.json contract shape", () => {
        const reviewerRules = parseReviewers("src/auth/ @Khan/Security");
        const result = route(
            {files: [file("src/auth/login.ts"), file("dist/bundle.js")]},
            {...baseConfig, generatedPatterns: ["dist/**"], reviewerRules},
        );
        const json = toRoutingJson(result);
        // Every tier is emitted in the display casing review.md consumes.
        expect(json.perFileTier).toEqual({
            "src/auth/login.ts": "High",
            "dist/bundle.js": "Trivial",
        });
        // owners covers source files only -- the generated file is excluded.
        expect(json.teams.owners).toEqual({"src/auth/login.ts": ["security"]});
        // The generated classification is exposed for the provenance CLI's
        // stripped whole-change diff.
        expect(json.generatedFiles).toEqual(["dist/bundle.js"]);
        expect(json.teams.fallback).toEqual(result.fallbackTeams);
        // The bounded question rides along for the orchestrator's second pass.
        expect(json.pendingRiskQuestions).toEqual(result.pendingRiskQuestions);
        expect(json.pendingRiskQuestions).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------------- */
/* runCli (Surface A entrypoint; fs injected so it is testable, no real I/O)  */
/* -------------------------------------------------------------------------- */

// runCli reads/writes these staging paths (module-private in router.ts; they
// are the review.md Step 3 on-disk contract, pinned here by literal).
const REVIEW_DIR = "/tmp/gh-aw/review";
const FILES_PATH = `${REVIEW_DIR}/files.json`;
const ROUTING_OUT = `${REVIEW_DIR}/routing.json`;
const RESOLVED_TIERS_PATH = `${REVIEW_DIR}/resolved-tiers.json`;
const GITATTRIBUTES_PATH = ".gitattributes";
const REVIEWERS_PATH = ".github/REVIEWERS";

// A structural stand-in for the node:fs subset runCli injects: existsSync +
// readFileSync answer from the supplied map, writes are recorded, and mkdir
// calls are captured -- no real filesystem is touched.
const fakeFs = (inputs: Record<string, string>) => {
    const written: Record<string, string> = {};
    const mkdirCalls: string[] = [];
    const fs = {
        readFileSync: (p: string, _enc: "utf8"): string => {
            const content = inputs[p];
            if (content === undefined) {
                throw new Error(`unexpected read: ${p}`);
            }
            return content;
        },
        writeFileSync: (p: string, data: string): void => {
            written[p] = data;
        },
        existsSync: (p: string): boolean => p in inputs,
        mkdirSync: (p: string, _opts: {recursive: boolean}): void => {
            mkdirCalls.push(p);
        },
    };
    return {fs, written, mkdirCalls};
};

describe("runCli", () => {
    it("routes a bare-array files.json using the repo's ROUTING config", () => {
        const {fs, written, mkdirCalls} = fakeFs({
            [FILES_PATH]: JSON.stringify([
                {path: "db/migrations/0001.sql", status: "added"},
            ]),
            [ROUTING_CONFIG_PATH]:
                "**/migrations/** tier=high lens=data-migrations",
        });
        const json = runCli(fs);
        expect(json.lensesToSpawn).toEqual(["data-migrations"]);
        expect(json.perFileTier).toEqual({"db/migrations/0001.sql": "High"});
        expect(json.runBudget.tier).toBe("high");
        expect(json.routingConfig).toEqual({present: true, warnings: []});
        // No REVIEWERS staged -> the source file is owned by nobody.
        expect(json.teams.owners).toEqual({"db/migrations/0001.sql": []});
        expect(json.teams.fallback).toEqual([]);
        // The output dir is created and the written JSON round-trips.
        expect(mkdirCalls).toEqual([REVIEW_DIR]);
        expect(JSON.parse(written[ROUTING_OUT])).toEqual(json);
    });

    it("clamps the run budget to the credit cap from the environment", () => {
        const {fs} = fakeFs({
            [FILES_PATH]: JSON.stringify([
                {path: "db/migrations/0001.sql", status: "added"},
            ]),
            [ROUTING_CONFIG_PATH]:
                "**/migrations/** tier=high lens=data-migrations",
        });
        const json = runCli(fs, ".", {REVIEW_MAX_AI_CREDITS: "400"});
        expect(json.runBudget.tier).toBe("high");
        expect(json.runBudget.capClamped).toBe(true);
        expect(json.runBudget.maxUsd).toBe(3);
        expect(json.runBudget.effectiveCreditCap).toBe(400);
    });

    it("accepts the {files:[...]} wrapper and degrades safely without a ROUTING config", () => {
        const {fs, written} = fakeFs({
            [FILES_PATH]: JSON.stringify({
                files: [{path: "README.md", status: "modified"}],
            }),
        });
        const json = runCli(fs);
        // Missing config: no rules, so no specialist lenses and the default
        // tier -- and the gap is loudly flagged, never silent.
        expect(json.lensesToSpawn).toEqual([]);
        expect(json.perFileTier).toEqual({"README.md": "Low"});
        expect(json.routingConfig.present).toBe(false);
        expect(json.routingConfig.warnings).toHaveLength(1);
        expect(json.routingConfig.warnings[0]).toContain(ROUTING_CONFIG_PATH);
        expect(JSON.parse(written[ROUTING_OUT])).toEqual(json);
    });

    it("surfaces ROUTING parse warnings in routingConfig", () => {
        const {fs} = fakeFs({
            [FILES_PATH]: JSON.stringify([{path: "a.ts", status: "modified"}]),
            [ROUTING_CONFIG_PATH]: "src/** lens=not-a-real-lens",
        });
        const json = runCli(fs);
        expect(json.routingConfig.present).toBe(true);
        expect(json.routingConfig.warnings.join("\n")).toContain(
            'unknown lens "not-a-real-lens"',
        );
    });

    it("parses .gitattributes/REVIEWERS/ROUTING and honours the resolved-tiers pass", () => {
        const {fs} = fakeFs({
            [FILES_PATH]: JSON.stringify([
                {path: "src/auth/login.ts", status: "modified"},
                {path: "dist/bundle.js", status: "modified"},
            ]),
            [GITATTRIBUTES_PATH]: "dist/** linguist-generated=true",
            [REVIEWERS_PATH]: "src/auth/ @Khan/Security",
            [ROUTING_CONFIG_PATH]:
                "**/auth/** tier=high direction-dependent lens=security-auth",
            [RESOLVED_TIERS_PATH]: JSON.stringify({"src/auth/login.ts": "Low"}),
        });
        const json = runCli(fs);
        // Generated file: excluded from ownership, trivial tier.
        expect(json.perFileTier).toEqual({
            "src/auth/login.ts": "Low",
            "dist/bundle.js": "Trivial",
        });
        expect(json.teams.owners).toEqual({"src/auth/login.ts": ["security"]});
        // The second pass resolved the auth tier -> no pending question remains.
        expect(json.pendingRiskQuestions).toEqual([]);
        expect(json.lensesToSpawn).toEqual(["security-auth"]);
        expect(json.runBudget.tier).toBe("low");
    });

    it("reads the repo files under an explicit repoRoot (REVIEW_REPO_ROOT)", () => {
        const {fs} = fakeFs({
            [FILES_PATH]: JSON.stringify([
                {path: "db/migrations/0001.sql", status: "added"},
            ]),
            ["/workspace/.github/aw/review/ROUTING"]:
                "**/migrations/** tier=high lens=data-migrations",
            ["/workspace/.gitattributes"]: "",
        });
        const json = runCli(fs, "/workspace");
        expect(json.routingConfig.present).toBe(true);
        expect(json.lensesToSpawn).toEqual(["data-migrations"]);
    });
});

/* -------------------------------------------------------------------------- */
/* parseRoutingConfig (the consumer-owned ROUTING file)                       */
/* -------------------------------------------------------------------------- */

describe("parseRoutingConfig", () => {
    it("parses lens, tier, and direction-dependent fields from one line", () => {
        const config = parseRoutingConfig(
            "**/auth/** tier=high direction-dependent lens=security-auth",
        );
        expect(config.lensRules).toEqual([
            {pattern: "**/auth/**", lenses: ["security-auth"]},
        ]);
        expect(config.riskRules).toEqual([
            {
                pattern: "**/auth/**",
                tier: "high",
                diffDirectionDependent: true,
            },
        ]);
        expect(config.warnings).toEqual([]);
    });

    it("skips blanks and comments and accepts multi-lens rules", () => {
        const config = parseRoutingConfig(
            [
                "# routing map",
                "",
                "**/*.proto lens=api-federation-compat,cross-deploy-serialization",
                "docs/** tier=trivial",
            ].join("\n"),
        );
        expect(config.lensRules).toEqual([
            {
                pattern: "**/*.proto",
                lenses: ["api-federation-compat", "cross-deploy-serialization"],
            },
        ]);
        expect(config.riskRules).toEqual([
            {pattern: "docs/**", tier: "trivial"},
        ]);
        expect(config.warnings).toEqual([]);
    });

    it("warns on an unknown lens and keeps the known ones", () => {
        const config = parseRoutingConfig(
            "src/** lens=security-auth,frontend-vibes",
        );
        expect(config.lensRules).toEqual([
            {pattern: "src/**", lenses: ["security-auth"]},
        ]);
        expect(config.warnings.join("\n")).toContain(
            'line 1: unknown lens "frontend-vibes"',
        );
    });

    it("skips a line with an unknown tier or unrecognised field, with a warning", () => {
        const config = parseRoutingConfig(
            ["src/** tier=extreme", "lib/** lenses=security-auth"].join("\n"),
        );
        expect(config.lensRules).toEqual([]);
        expect(config.riskRules).toEqual([]);
        expect(config.warnings).toHaveLength(2);
        expect(config.warnings[0]).toContain('unknown tier "extreme"');
        expect(config.warnings[1]).toContain(
            'unrecognised field "lenses=security-auth"',
        );
    });

    it("requires tier= alongside direction-dependent", () => {
        const config = parseRoutingConfig("src/** direction-dependent");
        expect(config.riskRules).toEqual([]);
        expect(config.warnings.join("\n")).toContain(
            "direction-dependent requires tier=",
        );
    });

    it("warns on a rule with neither lens= nor tier=", () => {
        const config = parseRoutingConfig("src/**");
        expect(config.lensRules).toEqual([]);
        expect(config.riskRules).toEqual([]);
        expect(config.warnings.join("\n")).toContain("no lens= or tier=");
    });
});

describe("parseRoutingConfig: enable directives", () => {
    it("collects enabled reviewers in canonical order, deduped", () => {
        const config = parseRoutingConfig(
            ["enable test-adequacy", "enable holistic,test-adequacy"].join(
                "\n",
            ),
        );
        expect(config.enabledReviewers).toEqual(["holistic", "test-adequacy"]);
        expect(config.warnings).toEqual([]);
    });

    it("warns on an unknown reviewer and keeps the known ones", () => {
        const config = parseRoutingConfig("enable holistic,skynet");
        expect(config.enabledReviewers).toEqual(["holistic"]);
        expect(config.warnings.join("\n")).toContain(
            'unknown reviewer "skynet"',
        );
    });

    it("warns on a bare enable line", () => {
        const config = parseRoutingConfig("enable");
        expect(config.enabledReviewers).toEqual([]);
        expect(config.warnings.join("\n")).toContain("names no reviewer");
    });

    it("defaults to no enabled reviewers", () => {
        expect(
            parseRoutingConfig("docs/** tier=trivial").enabledReviewers,
        ).toEqual([]);
    });
});

describe("runCli: enabled reviewers", () => {
    it("surfaces enable directives in routing.json", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
            [ROUTING_CONFIG_PATH]: "enable holistic,first-principles",
        });
        const json = runCli(fs);
        expect(json.enabledReviewers).toEqual(["holistic", "first-principles"]);
    });

    it("emits no enabled reviewers without a ROUTING config", () => {
        const {fs} = fakeFs({
            ["/tmp/gh-aw/review/files.json"]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
        });
        expect(runCli(fs).enabledReviewers).toEqual([]);
    });
});
