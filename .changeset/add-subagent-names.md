---
"review": patch
---

Add an explicit `name:` to each inline sub-agent's frontmatter (`correctness-reviewer`, `skill-auditor`, `pattern-triage`, `reviewer-mapper`, `thread-reconciler`, `claim-validator`). Recent gh-aw/Claude engine versions require sub-agents to declare a `name` rather than inferring it from the `## agent:` header, so without this the compiled workflow fails to dispatch them.
