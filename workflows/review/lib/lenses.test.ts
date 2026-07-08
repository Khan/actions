import {describe, it, expect} from "vitest";

import {
    FINDING_SCHEMA_VERSION,
    KNOWN_LENSES,
    validateFinding,
    type Finding,
    type Lens,
} from "./finding-schema.ts";
import {SPECIALIST_LENSES} from "./router.ts";

/**
 * Lens hunt fixtures.
 *
 * Slice 7 builds the eleven specialist lenses as prose sub-agent prompts in
 * `review.md`; the *judgment* half of a hunt (what to flag, severity, the
 * investigation) is model-owned and cannot be pinned deterministically. What
 * CAN be pinned -- and what the acceptance criterion asks for -- is the hunt
 * CONTRACT the proposal specifies: "each hunt is an executable procedure rather
 * than a vague 'look for X' ... and it reports whether it ran, was not
 * applicable, or found something, so a skipped check is visible and the eval
 * suite has something concrete to score" (proposal Idea, path-gated lenses).
 *
 * So this file is a self-contained, deterministic model of that tri-state
 * contract, one hunt per specialist lens, each derived from a documented Khan
 * incident (the same incident taxonomy the smoke corpus and full-suite
 * mutation set draw from -- this harness is the fixture format they reuse). For
 * every lens we assert the three states the proposal names:
 *
 *   - a known incident REPRO in the lens's paths       -> "found"  (+ a schema-valid Finding)
 *   - a correct in-scope change (defect absent)        -> "ran"    (no Finding)
 *   - a change entirely outside the lens's paths       -> "not-applicable"
 *
 * The detectors are intentionally narrow greppable signatures, not the
 * production hunts (those are the model's job in review.md). Their value here is
 * that they make the tri-state observable and let us prove two things the eval
 * suite cares about: a hunt fires on its repro, and a hunt does NOT fire on a
 * clean tree (no false-block). A cross-lens test also proves each repro trips
 * ONLY its owning lens, guarding against over-broad signatures.
 *
 * No I/O, no network, no model: pure functions over in-memory diff fixtures.
 */

/** A minimal changed-file fixture: the added/removed hunk lines the hunt scans. */
type DiffFixture = {
    path: string;
    added: string[];
    removed: string[];
};

/** The tri-state a hunt reports (proposal: "ran / not applicable / found"). */
type HuntState = "found" | "not-applicable" | "ran";

type HuntOutcome = {
    state: HuntState;
    /** Present iff state === "found". A schema-valid Finding for the incident. */
    finding?: Finding;
};

/** A detector match: the file + one evidence line justifying the finding. */
type DetectorMatch = {path: string; evidence: string} | null;

type LensHunt = {
    /** The specialist lens this hunt belongs to (a KNOWN_LENSES value). */
    lens: Lens;
    /** Stable provenance id, surfaced as Finding.producing_hunt. */
    id: string;
    /** One-line description of the incident the hunt reproduces. */
    description: string;
    /** Severity the incident warrants (drives the computed verdict downstream). */
    severity: Finding["severity"];
    /** True iff this file is within the lens's routed paths. */
    inScope: (path: string) => boolean;
    /** Scan in-scope files for the incident signature. */
    detect: (files: DiffFixture[]) => DetectorMatch;
    /** A minimal PR reintroducing the documented incident (must be "found"). */
    repro: DiffFixture[];
    /** A correct in-scope change with the defect absent (must be "ran"). */
    clean: DiffFixture[];
    /** A change touching none of the lens's paths (must be "not-applicable"). */
    outOfScope: DiffFixture[];
};

const anyAdded = (files: DiffFixture[], re: RegExp): DetectorMatch => {
    for (const f of files) {
        for (const line of f.added) {
            if (re.test(line)) {
                return {path: f.path, evidence: line.trim()};
            }
        }
    }
    return null;
};

const anyRemoved = (files: DiffFixture[], re: RegExp): DetectorMatch => {
    for (const f of files) {
        for (const line of f.removed) {
            if (re.test(line)) {
                return {path: f.path, evidence: line.trim()};
            }
        }
    }
    return null;
};

const addedHas = (files: DiffFixture[], re: RegExp): boolean =>
    files.some((f) => f.added.some((l) => re.test(l)));

/** Path-scope helper: case-insensitive keyword/extension match. */
const scope = (re: RegExp) => (path: string) => re.test(path);

/**
 * The eleven specialist lens hunts. Each `detect` returns a match ONLY on its
 * own incident signature; the `repro`/`clean`/`outOfScope` fixtures are crafted
 * so the tri-state is exercised. Incidents are cited to the proposal.
 */
const LENS_HUNTS: LensHunt[] = [
    {
        // Incident: PR #40536 -- acl.OpenAccess() on a field computed from
        // another user's identity (obj.Kaid), resolvable as a federation
        // entity: "OpenAccess lints clean but grants everyone".
        lens: "security-auth",
        id: "security-auth/openaccess-cross-user",
        description:
            "acl.OpenAccess() on a resolver field derived from another user's identity",
        severity: "blocking",
        inScope: scope(/(auth|acl|resolver|permission|session|security|csrf)/i),
        detect: (files) => {
            if (!addedHas(files, /acl\.OpenAccess\(/)) {
                return null;
            }
            const crossUser = anyAdded(
                files,
                /(obj\.Kaid|\.creatorKaid|otherUserId|targetUserId)/,
            );
            return crossUser;
        },
        repro: [
            {
                path: "services/progress/resolvers/user_progress.go",
                added: [
                    "func (r *Resolver) Progress(obj *UserProgress) acl.Decision {",
                    "  // resolvable as a federation entity keyed on obj.Kaid",
                    "  return acl.OpenAccess()",
                    "}",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/progress/resolvers/user_progress.go",
                added: [
                    "func (r *Resolver) Progress(obj *UserProgress) acl.Decision {",
                    "  return acl.CurrentUserOwns(obj.Kaid)",
                    "}",
                ],
                removed: [],
            },
        ],
        outOfScope: [
            {path: "docs/architecture.md", added: ["## Overview"], removed: []},
        ],
    },
    {
        // Incident: the moderation "universal-modifier drop" -- a new LLM call
        // not routed through moderation, or the universal modifier removed.
        lens: "ai-safety-moderation",
        id: "ai-safety-moderation/unmoderated-llm-call",
        description:
            "new LLM call not routed through moderation (universal modifier / safety gate dropped)",
        severity: "blocking",
        inScope: scope(
            /(moderation|(^|\/)ai\/|activity|prompt|assistant|tutor|llm)/i,
        ),
        detect: (files) => {
            const removedModifier = anyRemoved(
                files,
                /(universalModifier|applyUniversalModifier)/,
            );
            if (removedModifier) {
                return removedModifier;
            }
            const llmCall = anyAdded(
                files,
                /\b(callModel|callLLM|generateContent|completions\.create|openai\.|anthropic\.)\b/i,
            );
            if (!llmCall) {
                return null;
            }
            // A moderation call anywhere in the added hunk clears the hunt.
            if (addedHas(files, /moderat/i)) {
                return null;
            }
            return llmCall;
        },
        repro: [
            {
                path: "services/ai/tutor/generate.ts",
                added: [
                    "export async function generate(prompt: string) {",
                    "  const res = await callModel({prompt});",
                    "  return res.text;",
                    "}",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/ai/tutor/generate.ts",
                added: [
                    "export async function generate(prompt: string) {",
                    "  const safe = await moderate(prompt);",
                    "  const res = await callModel({prompt: safe});",
                    "  return res.text;",
                    "}",
                ],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "web/styles/theme.css",
                added: [".btn { color: red; }"],
                removed: [],
            },
        ],
    },
    {
        // Incident: ~36K-email misfire -- a new send path not gated on
        // hasSendableEmail (proposal: "every new send path gates on
        // hasSendableEmail ... minors never emailed").
        lens: "mass-comms-coppa",
        id: "mass-comms-coppa/ungated-send-path",
        description:
            "new email send path not gated on hasSendableEmail (COPPA / opt-out risk)",
        severity: "blocking",
        inScope: scope(/(email|(^|\/)send|comms|notif|mail|coppa)/i),
        detect: (files) => {
            const send = anyAdded(
                files,
                /(new SendEmailData\(|sendEmail\(|enqueueEmail\()/,
            );
            if (!send) {
                return null;
            }
            if (addedHas(files, /hasSendableEmail/)) {
                return null;
            }
            return send;
        },
        repro: [
            {
                path: "services/notifications/send_reminder.ts",
                added: [
                    "const data = new SendEmailData(recipient);",
                    "await enqueueEmail(data);",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/notifications/send_reminder.ts",
                added: [
                    "if (hasSendableEmail(recipient)) {",
                    "  const data = new SendEmailData(recipient);",
                    "  await enqueueEmail(data);",
                    "}",
                ],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "lib/math/geometry.ts",
                added: ["export const pi = 3.14;"],
                removed: [],
            },
        ],
    },
    {
        // Incident #13118: a rejected promise / error response cached
        // permanently, poisoning certificate rendering after one hiccup -- the
        // "fleet-wide cacheable-404".
        lens: "caching-resource",
        id: "caching-resource/cacheable-error",
        description:
            "caching an error / 4xx-5xx response or a rejected promise (poisons future reads)",
        severity: "blocking",
        inScope: scope(/(cache|cach|resource|memo)/i),
        detect: (files) => {
            if (!addedHas(files, /cache\.(set|put|store)\(/)) {
                return null;
            }
            // Signature of a poisoned cache write: it sits on a rejection /
            // error path (`.catch`, `reject`) or stores a non-2xx (4xx/5xx)
            // response. A success guard (`status === 200`) is NOT a match.
            const badCache = anyAdded(files, /(\.catch\(|reject|\b[45]\d\d\b)/);
            return badCache
                ? {
                      path: badCache.path,
                      evidence: `cache write alongside error path: ${badCache.evidence}`,
                  }
                : null;
        },
        repro: [
            {
                path: "services/cert/cache.ts",
                added: [
                    "fetchCert(id).catch((err) => {",
                    "  cache.set(id, err);",
                    "});",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/cert/cache.ts",
                added: [
                    "const cert = await fetchCert(id);",
                    "if (cert.status === 200) {",
                    "  cache.set(id, cert);",
                    "}",
                ],
                removed: [],
            },
        ],
        outOfScope: [
            {path: "docs/runbook.md", added: ["Restart the pod."], removed: []},
        ],
    },
    {
        // Proposal: "destructive or locking SQL migrations, index.yaml changes,
        // datastore model back-compat".
        lens: "data-migrations",
        id: "data-migrations/destructive-migration",
        description:
            "destructive/locking migration (DROP/TRUNCATE) breaking back-compat",
        severity: "blocking",
        inScope: scope(/(migration|\.sql$|index\.yaml$|datastore|schema\.py)/i),
        detect: (files) => {
            const drop =
                anyAdded(
                    files,
                    /\b(DROP\s+(COLUMN|TABLE)|ALTER\s+TABLE\s+\w+\s+DROP|TRUNCATE)\b/i,
                ) ?? anyRemoved(files, /\b(DROP\s+(COLUMN|TABLE)|TRUNCATE)\b/i);
            return drop;
        },
        repro: [
            {
                path: "migrations/0042_drop_legacy.sql",
                added: ["ALTER TABLE users DROP COLUMN legacy_flag;"],
                removed: [],
            },
        ],
        clean: [
            {
                path: "migrations/0043_add_pref.sql",
                added: ["ALTER TABLE users ADD COLUMN pref TEXT NULL;"],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "web/app.tsx",
                added: ["export const App = () => null;"],
                removed: [],
            },
        ],
    },
    {
        // Real catch class: a goroutine capturing a range/loop variable by
        // reference -- the classic Go concurrency bug (data race across
        // iterations). Proposal: "concurrency, data-integrity".
        lens: "concurrency-async",
        id: "concurrency-async/loop-var-capture",
        description:
            "goroutine captures a loop variable without rebinding (data race across iterations)",
        severity: "advisory",
        inScope: scope(
            /(worker|queue|concurren|goroutine|dispatch|\.go$|async)/i,
        ),
        detect: (files) => {
            for (const f of files) {
                const hasRange = f.added.some((l) =>
                    /for\b.*\brange\b/.test(l),
                );
                const goroutine = f.added.find((l) => /go\s+func\(\)/.test(l));
                if (!hasRange || !goroutine) {
                    continue;
                }
                // A rebind of the form `x := x` (same identifier) fixes it.
                const rebound = f.added.some((l) =>
                    /\b(\w+)\s*:=\s*\1\b/.test(l),
                );
                if (!rebound) {
                    return {path: f.path, evidence: goroutine.trim()};
                }
            }
            return null;
        },
        repro: [
            {
                path: "services/jobs/dispatch.go",
                added: [
                    "for _, item := range items {",
                    "  go func() {",
                    "    process(item)",
                    "  }()",
                    "}",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/jobs/dispatch.go",
                added: [
                    "for _, item := range items {",
                    "  item := item",
                    "  go func() {",
                    "    process(item)",
                    "  }()",
                    "}",
                ],
                removed: [],
            },
        ],
        outOfScope: [{path: "README.md", added: ["# Project"], removed: []}],
    },
    {
        // Incident class: removed schema fields / breaking GraphQL changes that
        // break shipped mobile clients; federation @key + ownership.
        lens: "api-federation-compat",
        id: "api-federation-compat/removed-schema-field",
        description:
            "removed GraphQL field or @key -- breaking change for shipped mobile clients",
        severity: "blocking",
        inScope: scope(/(\.graphql$|\.gql$|schema|federation)/i),
        detect: (files) =>
            anyRemoved(
                files,
                /(@key|extend\s+type|^\s*\w+\s*:\s*\[?\w+!?\]?!?\s*$)/,
            ),
        repro: [
            {
                path: "schema/content.graphql",
                added: [],
                removed: ["  legacyId: ID!"],
            },
        ],
        clean: [
            {
                path: "schema/content.graphql",
                added: ["  newField: String"],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "web/util/format.ts",
                added: ["export const x = 1;"],
                removed: [],
            },
        ],
    },
    {
        // Incident #12674 class: non-atomic deploy payload shape / serialized
        // formats read across the deploy skew window (protobuf field renumber,
        // PersistAcrossDeploy cache formats).
        lens: "cross-deploy-serialization",
        id: "cross-deploy-serialization/proto-field-reuse",
        description:
            "protobuf field removed/renumbered -- payload unreadable across the deploy skew window",
        severity: "blocking",
        inScope: scope(
            /(\.proto$|pubsub|cloudtask|persistacrossdeploy|serialize|payload)/i,
        ),
        detect: (files) => anyRemoved(files, /\b\w+\s*=\s*\d+\s*;/),
        repro: [
            {
                path: "protos/task.proto",
                added: ["  int64 priority = 3;"],
                removed: ["  int32 legacy_priority = 3;"],
            },
        ],
        clean: [
            {
                path: "protos/task.proto",
                added: ["  string new_tag = 7;"],
                removed: [],
            },
        ],
        outOfScope: [
            {path: "docs/deploy.md", added: ["Deploy nightly."], removed: []},
        ],
    },
    {
        // Incident: the CSP tightening that broke CS exercises for ~73K users;
        // deploy/infra config (Dockerfile, .tf, .yaml, CSP headers).
        lens: "deploy-infra-config",
        id: "deploy-infra-config/csp-tightening",
        description:
            "Content-Security-Policy tightened (source removed) -- can break existing pages",
        severity: "blocking",
        inScope: scope(
            /(Dockerfile|\.tf$|\.ya?ml$|csp|content-security|nginx|ingress)/i,
        ),
        detect: (files) =>
            anyRemoved(
                files,
                /(script-src|Content-Security-Policy|https:\/\/)/,
            ),
        repro: [
            {
                path: "deploy/csp.yaml",
                added: ['    script-src: "self"'],
                removed: [
                    '    script-src: "self https://*.khanacademy.org https://cdn.jsdelivr.net"',
                ],
            },
        ],
        clean: [
            {
                path: "deploy/service.yaml",
                added: ["  replicas: 3"],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "src/util/date.ts",
                added: ["export const now = 0;"],
                removed: [],
            },
        ],
    },
    {
        // Proposal: "Donations and Stripe: webhook signature validation, charge
        // and refund idempotency, amount and tax math. Rare, high-stakes."
        lens: "money-payments",
        id: "money-payments/non-idempotent-charge",
        description:
            "Stripe charge/paymentIntent created without an idempotency key (double-charge risk)",
        severity: "blocking",
        inScope: scope(
            /(stripe|payment|charge|refund|webhook|donation|billing|checkout)/i,
        ),
        detect: (files) => {
            const create = anyAdded(
                files,
                /stripe\.(charges|paymentIntents)\.create\(/,
            );
            if (!create) {
                return null;
            }
            if (addedHas(files, /idempotenc/i)) {
                return null;
            }
            return create;
        },
        repro: [
            {
                path: "services/donations/charge.ts",
                added: [
                    "const charge = await stripe.paymentIntents.create({amount, currency: 'usd'});",
                ],
                removed: [],
            },
        ],
        clean: [
            {
                path: "services/donations/charge.ts",
                added: [
                    "const charge = await stripe.paymentIntents.create({amount, currency: 'usd'}, {idempotencyKey: key});",
                ],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "web/components/nav.tsx",
                added: ["export const Nav = () => null;"],
                removed: [],
            },
        ],
    },
    {
        // Proposal: "content & i18n" -- a user-facing string shipped without
        // going through i18n (untranslatable, and content-policy invisible).
        lens: "content-i18n",
        id: "content-i18n/unwrapped-user-string",
        description:
            "hardcoded user-facing string not wrapped in i18n (untranslatable)",
        severity: "advisory",
        inScope: scope(/(i18n|content|translat|message|locale|intl)/i),
        detect: (files) => {
            const hardcoded = anyAdded(
                files,
                /(label|title|placeholder|children)\s*[:=]\s*["'][A-Z][a-z]{2,}/,
            );
            if (!hardcoded) {
                return null;
            }
            if (addedHas(files, /(i18n\._|<Msg\b|\bt\()/)) {
                return null;
            }
            return hardcoded;
        },
        repro: [
            {
                path: "web/content/banner.tsx",
                added: ['<Button label="Submit answer" />'],
                removed: [],
            },
        ],
        clean: [
            {
                path: "web/content/banner.tsx",
                added: ['<Button label={i18n._("Submit answer")} />'],
                removed: [],
            },
        ],
        outOfScope: [
            {
                path: "migrations/0099_index.sql",
                added: ["CREATE INDEX ...;"],
                removed: [],
            },
        ],
    },
];

/**
 * Run a hunt over a changed-file list and report the tri-state. Mirrors the
 * contract the review.md lens sub-agents must honor: not-applicable when none of
 * the lens's paths are touched, found when the incident signature matches (with
 * a schema-valid Finding), ran otherwise.
 */
const runHunt = (hunt: LensHunt, files: DiffFixture[]): HuntOutcome => {
    const inScope = files.filter((f) => hunt.inScope(f.path));
    if (inScope.length === 0) {
        return {state: "not-applicable"};
    }

    const match = hunt.detect(inScope);
    if (!match) {
        return {state: "ran"};
    }

    const finding: Finding = {
        schema_version: FINDING_SCHEMA_VERSION,
        id: `${hunt.id}#${match.path}`,
        lens: hunt.lens,
        anchor: {type: "line", path: match.path, line: 1, side: "RIGHT"},
        severity: hunt.severity,
        confidence: 0.9,
        evidence_trace: [
            `hunt ${hunt.id} fired in ${match.path}`,
            match.evidence,
        ],
        producing_hunt: hunt.id,
        model_authored_prose: hunt.description,
    };
    return {state: "found", finding};
};

describe("specialist lens hunt fixtures", () => {
    it("covers every specialist lens with at least one hunt", () => {
        const covered = new Set(LENS_HUNTS.map((h) => h.lens));
        for (const lens of SPECIALIST_LENSES) {
            expect(
                covered.has(lens),
                `no hunt fixture for specialist lens "${lens}"`,
            ).toBe(true);
        }
        // Every hunt targets a known specialist lens (guards against typos and
        // against attaching a hunt to an always-on/triage lens).
        for (const hunt of LENS_HUNTS) {
            expect(SPECIALIST_LENSES).toContain(hunt.lens);
            expect(KNOWN_LENSES).toContain(hunt.lens);
        }
        // Exactly the eleven specialist lenses, one hunt each, no duplicates.
        expect(covered.size).toBe(SPECIALIST_LENSES.length);
        expect(LENS_HUNTS.length).toBe(SPECIALIST_LENSES.length);
    });

    it("hunt and Finding ids are unique across lenses", () => {
        const ids = LENS_HUNTS.map((h) => h.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    describe.each(LENS_HUNTS.map((h) => [h.lens, h] as const))(
        "%s",
        (_lens, hunt) => {
            it("FIRES on the incident repro (state=found) with a schema-valid finding", () => {
                const outcome = runHunt(hunt, hunt.repro);
                expect(outcome.state).toBe("found");
                expect(outcome.finding).toBeDefined();

                const finding = outcome.finding as Finding;
                // The finding is attributed to this lens and this hunt...
                expect(finding.lens).toBe(hunt.lens);
                expect(finding.producing_hunt).toBe(hunt.id);
                // ...and it emits into the real finding schema (the goal:
                // "findings emit valid schema").
                const result = validateFinding(finding);
                expect(
                    result.ok,
                    result.ok ? "" : result.errors.join("; "),
                ).toBe(true);
                expect(finding.evidence_trace.length).toBeGreaterThan(0);
            });

            it("is NOT-APPLICABLE when none of the lens's paths are touched", () => {
                const outcome = runHunt(hunt, hunt.outOfScope);
                expect(outcome.state).toBe("not-applicable");
                expect(outcome.finding).toBeUndefined();
            });

            it("RAN clean on a correct in-scope change (no false finding)", () => {
                const outcome = runHunt(hunt, hunt.clean);
                expect(outcome.state).toBe("ran");
                expect(outcome.finding).toBeUndefined();
            });
        },
    );

    it("each repro trips ONLY its owning lens (no cross-lens false positives)", () => {
        for (const source of LENS_HUNTS) {
            const firing = LENS_HUNTS.filter(
                (h) => runHunt(h, source.repro).state === "found",
            ).map((h) => h.lens);
            expect(
                firing,
                `${source.lens} repro also fired: ${firing.join(", ")}`,
            ).toEqual([source.lens]);
        }
    });

    it("a clean tree produces no findings from any lens", () => {
        for (const source of LENS_HUNTS) {
            for (const hunt of LENS_HUNTS) {
                const outcome = runHunt(hunt, source.clean);
                expect(
                    outcome.state,
                    `${hunt.lens} fired on ${source.lens}'s clean fixture`,
                ).not.toBe("found");
            }
        }
    });
});
