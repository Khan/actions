# Review Bot — Architecture Spec

A gh-aw agentic workflow (`review.md`) that reviews PRs. An LLM **orchestrator** runs a
mostly scripted pipeline: deterministic TS in `lib/` does staging, routing, dispatch,
verdict and rendering; the orchestrator mostly just shuttles the result into GitHub
safe outputs. Sub-agents are read-only and return JSON.

## 1. Deployment / runtime context

```mermaid
flowchart LR
  subgraph Consumer["Consumer repo"]
    WF["review.md (copied via gh-aw source: import)"]
    CFG[".github/aw/review/ROUTING<br/>+ imported add-reviewer safe output"]
  end
  subgraph Actions["Khan/actions @ review-vX.Y.Z"]
    LIB["workflows/review/lib/*.ts"]
    EVAL["workflows/review/eval/ (offline only)"]
  end
  PR(["PR event:<br/>opened / synchronize /<br/>reopened / ready_for_review"]) --> AJ
  subgraph GHA["GitHub Actions run"]
    AJ["agent job<br/>(pre-steps → orchestrator → post-steps)"]
    SO["safe_outputs job<br/>(holds write token)"]
  end
  WF --> AJ
  CFG --> AJ
  LIB -- "checkout at pinned ref" --> AJ
  AJ -- "agent_output.json queue" --> SO
  SO -- "review, comments, resolves,<br/>add-comment, add-reviewer" --> GH[(GitHub API)]
  AJ -- "Claude API via awf api-proxy<br/>(credit metering/caps)" --> ANT[(Anthropic)]
  AJ -- traces --> SEN[(Sentry OTLP)]
```

## 2. End-to-end execution path (agent job)

```mermaid
sequenceDiagram
  autonumber
  participant Pre as pre-agent steps
  participant O as Orchestrator (Opus, review.md prompt)
  participant D as lib/dispatch.ts
  participant SA as Sub-agents (Agent SDK)
  participant S as lib/submission.ts
  participant Post as post-agent steps
  participant FS as /tmp/gh-aw/review/

  Pre->>Pre: checkout lib, copy to $RUNNER_TEMP (tamper-proof)
  Pre->>FS: stage-pr.ts → PR ctx, diffs, threads, routing.json,<br/>provenance.json, rereview-plan.json
  Pre->>Pre: npm ci (Agent SDK)
  O->>FS: read staged context (Step 1–2, early exit?)
  opt pendingRiskQuestions
    O->>FS: resolved-tiers.json, re-run router.ts
  end
  O->>FS: author-disputes.json (only LLM judgment left)
  O->>D: one blocking Bash call (≤60 min)
  D->>SA: triage → finder fan-out → clusterer → validator
  SA-->>D: JSON findings (+ prose-judge rewrite loop)
  D->>FS: dispatch-result.json
  O->>S: submission.ts
  S->>FS: submission-plan.json (verdict, comments, body, resolves)
  O->>O: emit safe outputs verbatim from plan<br/>(or HOLD_FOR_HUMAN → add-comment)
  O->>O: Step 7/8 on APPROVE: risks comment, team reviewers
  O->>FS: cache-record.ts → cache-memory/pr-*.json
  Post->>Post: dispatch-gate.ts — queue vs plan, strip on violation
  Post->>Post: cost-report-cli.ts
  Post->>Post: dismiss-review.ts (reduced-depth dismissal)
```

## 3. Module map (by pipeline stage)

```mermaid
flowchart TB
  subgraph Stage["Staging — stage-pr.ts"]
    diff
    threads
    stageTicket[stage-ticket]
    versionFooter[version-footer]
    router --> routingConfig[routing-config] & budgets & creditCap[credit-cap] & lensPayloads[lens-payloads] & globMatch[glob-match]
    provenance
    rereviewMode[rereview-mode] --> rereview
  end
  subgraph Dispatch["Dispatch — dispatch.ts"]
    runner[dispatch-runner<br/>Claude Agent SDK] 
    roster[dispatch-roster<br/>dispatch-contracts<br/>dispatch-agents]
    dedupAll[dedup / dedup-crossfile /<br/>dedup-cluster / dedup-threads<br/>dispatch-cluster]
    judge[judge-prose + runner<br/>refusal-fallback, pricing]
  end
  subgraph Submit["Submission — submission.ts"]
    verdict
    render[submission-render / render-comment<br/>attribution, depth-note,<br/>sanitizer-normalize, notified]
    clearance[submission-clearance]
  end
  subgraph PostAgent["Post-agent (from $RUNNER_TEMP copy)"]
    gate[dispatch-gate + dispatch-gate-plan]
    cost[cost-report-cli]
    dismiss[dismiss-review]
  end
  Stage -->|files on disk| Dispatch -->|dispatch-result.json| Submit -->|submission-plan.json| PostAgent
  cacheRecord[cache-record] -.-> Submit
  clearance -.shared predicate.-> gate & dismiss
```

## 4. Known debt / dead paths (to investigate)

- `dispatch agent` mode (orchestrator spawns sub-agents via gh-aw) vs default `scripted`; likely vestigial, still documented in prompt.
- Sub-agent prompts all live inline in `review.md` (~3.8k lines; ~20 agents).
- `eval/` is a parallel system (replay + live A/B); not in the runtime path.

## Next sections (TBD)

- Staging & routing detail
- Dispatch pipeline & sub-agent roster
- Verdict / submission rules
- Re-review depth modes
- Gate & post-agent safety
- Cache memory lifecycle
