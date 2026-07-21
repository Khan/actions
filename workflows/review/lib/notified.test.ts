import {describe, it, expect} from "vitest";

import {
    compileDiffRegex,
    computeNotifications,
    computeNotifiedResult,
    globToRegExpSource,
    matchGlob,
    notifiedSignature,
    parseNotified,
    parseRuleLine,
    renderNotifiedMarkdown,
    runCli,
    type NotifyRule,
    type PrChanges,
} from "./notified.ts";

/**
 * Unit tests for `.github/NOTIFIED` handling. Fixtures mirror the real Gerald
 * format: the documentation-plus-marker preamble, the two `[SECTION]` blocks,
 * label-prefixed rules, path globs, and quoted diff regexes (drawn from the
 * rules Khan/webapp actually ships).
 */

/** A NOTIFIED file shaped like the ones the repos ship. */
const NOTIFIED_FIXTURE = [
    "[NOTIFY RULES]",
    "",
    "Examples:",
    "# **/*   @should-be-ignored", // above the marker: documentation only
    "",
    "----Everything above this line will be ignored!----",
    "[ON PULL REQUEST] (DO NOT DELETE THIS LINE)",
    "",
    "# a comment inside the section",
    "deploy: deploy/** @Khan/infra-platform",
    "yaml:   {index,ka-cron,pubsub}.yaml  @csilvers",
    "graphql: services/*.graphql   @seandriedger @Khan/data",
    'new-model: "/^\\+(?!\\+).*\\bModelHoldsUserSpecificData\\(\\)/m"  @Khan/infra-platform',
    "bare-rule-no-mention: docs/**", // no @mention -> skipped
    "trailing: src/** @octocat # notify octocat on any src change",
    "",
    "[ON PUSH WITHOUT PULL REQUEST] (DO NOT DELETE THIS LINE)",
    "",
    "push-only: deploy/** @should-not-be-parsed",
].join("\n");

describe("parseNotified", () => {
    it("parses only the [ON PULL REQUEST] section, below the marker", () => {
        const {rules, warnings} = parseNotified(NOTIFIED_FIXTURE);
        expect(warnings).toEqual([]);
        // The push-only rule, the documentation rule, and the mention-less
        // rule are all excluded.
        expect(rules.map((r) => r.label)).toEqual([
            "deploy",
            "yaml",
            "graphql",
            "new-model",
            "trailing",
        ]);
    });

    it("captures labels, patterns, kinds, and mentions", () => {
        const {rules} = parseNotified(NOTIFIED_FIXTURE);
        const byLabel = Object.fromEntries(rules.map((r) => [r.label, r]));

        expect(byLabel["deploy"]).toMatchObject({
            kind: "glob",
            patternSource: "deploy/**",
            mentions: ["@Khan/infra-platform"],
        });
        expect(byLabel["graphql"]?.mentions).toEqual([
            "@seandriedger",
            "@Khan/data",
        ]);
        expect(byLabel["new-model"]).toMatchObject({
            kind: "regex",
            patternSource:
                "/^\\+(?!\\+).*\\bModelHoldsUserSpecificData\\(\\)/m",
        });
    });

    it("stops mentions at an inline # comment", () => {
        const {rules} = parseNotified(NOTIFIED_FIXTURE);
        const trailing = rules.find((r) => r.label === "trailing");
        expect(trailing?.mentions).toEqual(["@octocat"]);
    });

    it("returns no rules when the PR section is absent", () => {
        const {rules} = parseNotified(
            "[ON PUSH WITHOUT PULL REQUEST]\nx: a/** @who",
        );
        expect(rules).toEqual([]);
    });

    it("parses a file with no ignore marker", () => {
        const {rules} = parseNotified(
            "[ON PULL REQUEST]\ndeploy/** @Khan/infra",
        );
        expect(rules).toHaveLength(1);
        expect(rules[0]?.mentions).toEqual(["@Khan/infra"]);
    });

    it("does not treat a leading character-class glob as a section header", () => {
        // `[Dd]ockerfile` leads with `[` but is a rule, not a header: it (and
        // every rule after it) must still parse.
        const {rules} = parseNotified(
            [
                "[ON PULL REQUEST]",
                "[Dd]ockerfile @Khan/infra",
                "later: src/** @octocat",
            ].join("\n"),
        );
        expect(rules.map((r) => r.mentions)).toEqual([
            ["@Khan/infra"],
            ["@octocat"],
        ]);
        expect(rules[0]?.patternSource).toBe("[Dd]ockerfile");
    });

    it("surfaces a warning for an invalid diff-regex body", () => {
        const {rules, warnings} = parseNotified(
            '[ON PULL REQUEST]\nbad: "/(unbalanced/" @who\ngood: deploy/** @ok',
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("invalid regex");
        // The bad rule is dropped, but a later valid rule still parses.
        expect(rules.map((r) => r.label)).toEqual(["good"]);
    });
});

describe("parseRuleLine", () => {
    it("drops a trailing ! from a mention (REVIEWERS required marker)", () => {
        const rule = parseRuleLine("**/* @Khan/github-actions!");
        expect(rule).toMatchObject({mentions: ["@Khan/github-actions"]});
    });

    it("returns null for a rule with no mention", () => {
        expect(parseRuleLine("deploy/**")).toBeNull();
    });

    it("warns on an unterminated quoted pattern", () => {
        const result = parseRuleLine('bad: "/unterminated  @who');
        expect(result).toMatchObject({warning: expect.stringContaining("bad")});
    });

    it("treats a quoted pattern as a diff regex, not a label", () => {
        const rule = parseRuleLine('"/a:b/m" @who');
        expect(rule).toMatchObject({kind: "regex", patternSource: "/a:b/m"});
    });

    it("ignores @mentions inside a trailing # comment", () => {
        const rule = parseRuleLine(
            "src/** @octocat # also ping @not-a-real-mention later",
        );
        expect(rule).toMatchObject({mentions: ["@octocat"]});
    });
});

describe("matchGlob", () => {
    // A malformed glob never throws: it degrades to a literal (so an unbalanced
    // `[` matches only the literal text), which the last rows assert. If any row
    // caused matchGlob to throw, the case would fail rather than return a value.
    it.each<[string, string, boolean]>([
        // Real webapp glob rules.
        ["deploy/**", "deploy/prod.yaml", true],
        ["deploy/**", "deploy/a/b/c.yaml", true],
        ["deploy/**", "services/deploy.yaml", false],
        ["services/*.graphql", "services/assignments/x.graphql", false], // * ⊄ /
        ["services/*.graphql", "services/x.graphql", true],
        [".agents/skills/**", ".agents/skills/a.md", true],
        // {a,b,c} brace alternation (anchored: no match at a nested depth).
        ["{index,ka-cron,pubsub}.yaml", "index.yaml", true],
        ["{index,ka-cron,pubsub}.yaml", "ka-cron.yaml", true],
        ["{index,ka-cron,pubsub}.yaml", "pubsub.yaml", true],
        ["{index,ka-cron,pubsub}.yaml", "other.yaml", false],
        ["{index,ka-cron,pubsub}.yaml", "dir/index.yaml", false],
        // Anchored at the repo root; **/ is written for any depth (like Gerald).
        ["*.js", "a.js", true],
        ["*.js", "src/a.js", false],
        ["**/*.js", "a.js", true], // **/ optional at root
        ["**/*.js", "src/a.js", true],
        ["**/*.js", "src/deep/a.js", true],
        // `.` is a literal, not a wildcard.
        ["*.js", "axjs", false],
        // Regex-group and brace alternation are equivalent.
        ["**/*.(js|txt|yml)", "a.txt", true],
        ["**/*.(js|txt|yml)", "a.md", false],
        ["**/*.{js,txt,yml}", "a.yml", true],
        // Extglobs: ?(…) optional, +(…) one-or-more, *(…) zero-or-more, @(…) one.
        ["main?(.test).js", "main.js", true],
        ["main?(.test).js", "main.test.js", true],
        ["main?(.test).js", "main.spec.js", false],
        ["+(a).js", "aaa.js", true],
        ["+(a).js", ".js", false],
        ["*(a).js", ".js", true],
        ["@(a|b).js", "a.js", true],
        ["@(a|b).js", "ab.js", false],
        // Character classes and POSIX classes (incl. a leading class).
        ["[Dd]ockerfile", "Dockerfile", true],
        ["[Dd]ockerfile", "dockerfile", true],
        ["[Dd]ockerfile", "Makefile", false],
        ["file-[1-5]", "file-3", true],
        ["file-[1-5]", "file-9", false],
        ["file-[[:digit:]]", "file-7", true],
        ["file-[[:digit:]]", "file-x", false],
        // Basename-substring style.
        ["**/*gerald*", "src/my-gerald-tool.ts", true],
        // Malformed glob: degrades to a literal, never throws.
        ["[unterminated", "[unterminated", true],
        ["[unterminated", "a", false],
    ])("%j matches %j => %s", (pattern, path, expected) => {
        expect(matchGlob(path, pattern)).toBe(expected);
    });
});

describe("globToRegExpSource", () => {
    it("produces the expected regex source for a globstar", () => {
        expect(globToRegExpSource("deploy/**")).toBe("deploy/.*");
        expect(globToRegExpSource("**/*.js")).toBe("(?:.*/)?[^/]*\\.js");
    });
});

describe("compileDiffRegex", () => {
    it("compiles a /body/flags regex and strips g/y", () => {
        const re = compileDiffRegex("/gerald/ig");
        expect(re).not.toBeNull();
        expect(re?.flags).toBe("i");
        expect(re?.test("has GERALD here")).toBe(true);
    });

    it("matches added lines with the webapp-style anchor", () => {
        const re = compileDiffRegex("/^\\+(?!\\+).*\\bMergedGetAll\\b/m");
        expect(re?.test("+  x := MergedGetAll()")).toBe(true);
        expect(re?.test("+++ b/file.go\n MergedGetAll")).toBe(false); // header + context
    });

    it("returns null on a malformed regex", () => {
        expect(compileDiffRegex("/(unbalanced/")).toBeNull();
    });

    it("compiles a bare (unslashed) body", () => {
        expect(compileDiffRegex("plain")?.test("a plain string")).toBe(true);
    });
});

const RULES: NotifyRule[] = [
    {
        label: "deploy",
        patternSource: "deploy/**",
        kind: "glob",
        mentions: ["@infra"],
    },
    {
        label: "model",
        patternSource: "/^\\+(?!\\+).*\\bModelHoldsUserSpecificData\\(\\)/m",
        kind: "regex",
        mentions: ["@infra", "@data"],
    },
];

const CHANGES: PrChanges = {
    changedPaths: ["deploy/prod.yaml", "services/user.go", "src/index.ts"],
    fileDiffs: {
        "deploy/prod.yaml":
            "diff --git a/deploy/prod.yaml b/deploy/prod.yaml\n" +
            "--- a/deploy/prod.yaml\n+++ b/deploy/prod.yaml\n" +
            "@@ -1 +1 @@\n-replicas: 1\n+replicas: 2\n",
        "services/user.go":
            "diff --git a/services/user.go b/services/user.go\n" +
            "--- a/services/user.go\n+++ b/services/user.go\n" +
            "@@ -1,2 +1,3 @@\n func f() {\n" +
            "+    _ = ModelHoldsUserSpecificData()\n }\n",
        "src/index.ts":
            "diff --git a/src/index.ts b/src/index.ts\n" +
            "--- a/src/index.ts\n+++ b/src/index.ts\n" +
            "@@ -1 +1 @@\n-const x = 1\n+const x = 2\n",
    },
};

describe("computeNotifications", () => {
    it("matches globs by path and regexes by diff text", () => {
        const notifications = computeNotifications(RULES, CHANGES);
        const byMention = Object.fromEntries(
            notifications.map((n) => [n.mention, n]),
        );

        // @infra: deploy glob (prod.yaml) + model regex (user.go).
        expect(byMention["@infra"]?.files).toEqual([
            "deploy/prod.yaml",
            "services/user.go",
        ]);
        expect(byMention["@infra"]?.entries).toEqual([
            {label: "deploy", files: ["deploy/prod.yaml"]},
            {label: "model", files: ["services/user.go"]},
        ]);
        // @data: only the model regex.
        expect(byMention["@data"]?.files).toEqual(["services/user.go"]);
        // src/index.ts matched no rule.
        expect(
            notifications.flatMap((n) => n.files).includes("src/index.ts"),
        ).toBe(false);
    });

    it("merges files from two rules that share a label", () => {
        const rules: NotifyRule[] = [
            {
                label: "proto",
                patternSource: "a/**",
                kind: "glob",
                mentions: ["@x"],
            },
            {
                label: "proto",
                patternSource: "b/**",
                kind: "glob",
                mentions: ["@x"],
            },
        ];
        const changes: PrChanges = {
            changedPaths: ["a/one.ts", "b/two.ts"],
            fileDiffs: {},
        };
        const [notification] = computeNotifications(rules, changes);
        expect(notification?.entries).toEqual([
            {label: "proto", files: ["a/one.ts", "b/two.ts"]},
        ]);
    });

    it("sorts mentions and is stable", () => {
        const notifications = computeNotifications(RULES, CHANGES);
        expect(notifications.map((n) => n.mention)).toEqual([
            "@data",
            "@infra",
        ]);
    });

    it("skips a regex rule whose pattern will not compile", () => {
        const rules: NotifyRule[] = [
            {patternSource: "/(bad/", kind: "regex", mentions: ["@x"]},
        ];
        expect(computeNotifications(rules, CHANGES)).toEqual([]);
    });
});

describe("renderNotifiedMarkdown", () => {
    it("returns an empty string when nothing matched", () => {
        expect(renderNotifiedMarkdown([])).toBe("");
    });

    it("renders raw @mentions with their labels and files", () => {
        // Full block as one snapshot, so a reader sees the exact posted shape.
        expect(renderNotifiedMarkdown(computeNotifications(RULES, CHANGES)))
            .toMatchInlineSnapshot(`
          "### Notified

          These people and teams asked (via \`.github/NOTIFIED\`) to be notified of the changes below:

          - @data — **model**: \`services/user.go\`
          - @infra — **deploy**: \`deploy/prod.yaml\`; **model**: \`services/user.go\`
          "
        `);
    });

    it("caps a long file list with an overflow tail", () => {
        const files = Array.from({length: 15}, (_, i) => `pkg/f${i}.ts`);
        const rules: NotifyRule[] = [
            {
                label: "all",
                patternSource: "pkg/**",
                kind: "glob",
                mentions: ["@x"],
            },
        ];
        const changes: PrChanges = {changedPaths: files, fileDiffs: {}};
        const md = renderNotifiedMarkdown(computeNotifications(rules, changes));
        expect(md).toContain("(+5 more)");
    });
});

describe("notifiedSignature", () => {
    it("produces a signature that changes with the matched set", () => {
        const full = notifiedSignature(computeNotifications(RULES, CHANGES));
        const fewer = notifiedSignature(
            computeNotifications(RULES, {
                changedPaths: ["deploy/prod.yaml"],
                fileDiffs: {},
            }),
        );
        expect(full).not.toBe(fewer);
        // Stable across recomputation.
        expect(full).toBe(
            notifiedSignature(computeNotifications(RULES, CHANGES)),
        );
    });
});

describe("computeNotifiedResult", () => {
    it("reports present:false when the file is absent", () => {
        const result = computeNotifiedResult(null, {
            changedPaths: ["a.ts"],
            fileDiffs: {},
        });
        expect(result).toMatchObject({
            present: false,
            matched: false,
            markdown: "",
            signature: "",
        });
    });

    it("reports present:true but matched:false for a rule-less file", () => {
        const result = computeNotifiedResult(
            "[ON PULL REQUEST]\n# nothing here\n",
            {changedPaths: ["a.ts"], fileDiffs: {}},
        );
        expect(result.present).toBe(true);
        expect(result.matched).toBe(false);
        expect(result.markdown).toBe("");
    });

    it("returns the full result when rules match", () => {
        const content =
            "[ON PULL REQUEST]\ndeploy: deploy/** @Khan/infra-platform\n";
        const result = computeNotifiedResult(content, CHANGES);
        expect(result.matched).toBe(true);
        expect(result.notifications[0]?.mention).toBe("@Khan/infra-platform");
        expect(result.markdown).toContain("### Notified");
    });

    it("carries a malformed-rule warning through to the result", () => {
        // End-to-end: a bad regex body must reach `warnings[]` so Step 7 can
        // emit a PR `Note:` — not be dropped silently.
        const result = computeNotifiedResult(
            '[ON PULL REQUEST]\nbad: "/(unbalanced/" @who\n',
            {changedPaths: ["a.ts"], fileDiffs: {}},
        );
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("invalid regex");
    });
});

describe("runCli", () => {
    const makeFs = (files: Record<string, string>) => {
        const written: Record<string, string> = {};
        const fs = {
            readFileSync: (p: string) => {
                const content = files[p];
                if (content === undefined) {
                    throw new Error(`ENOENT: ${p}`);
                }
                return content;
            },
            writeFileSync: (p: string, data: string) => {
                written[p] = data;
            },
            existsSync: (p: string) => p in files,
            mkdirSync: () => undefined,
        };
        return {fs, written};
    };

    const REVIEW_DIR = "/tmp/gh-aw/review";

    it("reads staged inputs and writes notified.json", () => {
        const {fs, written} = makeFs({
            "/repo/.github/NOTIFIED":
                "[ON PULL REQUEST]\ndeploy: deploy/** @Khan/infra-platform\n",
            [`${REVIEW_DIR}/files.json`]: JSON.stringify({
                files: [
                    {path: "deploy/prod.yaml", status: "modified"},
                    {path: "src/index.ts", status: "modified"},
                ],
            }),
            [`${REVIEW_DIR}/full.diff`]: CHANGES.fileDiffs["deploy/prod.yaml"],
        });

        const result = runCli(fs, "/repo");
        // Snapshot the whole result so the shape review.md consumes is visible
        // at a glance (also proves the deploy/** glob matched, src/ did not).
        expect(result).toMatchInlineSnapshot(`
          {
            "markdown": "### Notified

          These people and teams asked (via \`.github/NOTIFIED\`) to be notified of the changes below:

          - @Khan/infra-platform — **deploy**: \`deploy/prod.yaml\`
          ",
            "matched": true,
            "notifications": [
              {
                "entries": [
                  {
                    "files": [
                      "deploy/prod.yaml",
                    ],
                    "label": "deploy",
                  },
                ],
                "files": [
                  "deploy/prod.yaml",
                ],
                "mention": "@Khan/infra-platform",
              },
            ],
            "present": true,
            "signature": "@Khan/infra-platform=deploy:deploy/prod.yaml",
            "warnings": [],
          }
        `);
        // The same object is what gets persisted to notified.json for Step 7.
        expect(
            JSON.parse(written[`${REVIEW_DIR}/notified.json`] ?? "null"),
        ).toEqual(result);
    });

    it("handles a missing NOTIFIED file", () => {
        const {fs, written} = makeFs({
            [`${REVIEW_DIR}/files.json`]: JSON.stringify([
                {path: "a.ts", status: "modified"},
            ]),
        });
        const result = runCli(fs, "/repo");
        expect(result.present).toBe(false);
        expect(written[`${REVIEW_DIR}/notified.json`]).toBeDefined();
    });

    it("matches a diff-regex rule against the staged full.diff", () => {
        const {fs} = makeFs({
            "/repo/.github/NOTIFIED":
                "[ON PULL REQUEST]\n" +
                'model: "/^\\+(?!\\+).*\\bModelHoldsUserSpecificData\\(\\)/m" @Khan/infra-platform\n',
            [`${REVIEW_DIR}/files.json`]: JSON.stringify([
                {path: "services/user.go", status: "modified"},
            ]),
            [`${REVIEW_DIR}/full.diff`]: CHANGES.fileDiffs["services/user.go"],
        });
        const result = runCli(fs, "/repo");
        expect(result.matched).toBe(true);
        expect(result.notifications[0]?.mention).toBe("@Khan/infra-platform");
        expect(result.notifications[0]?.files).toEqual(["services/user.go"]);
    });
});
