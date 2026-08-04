---
"review": minor
---

review: honour `linguist-generated=false` the way git does, so deliberately un-marked files get reviewed

The router read `.gitattributes` as a set of "generated globs" and asked whether a
path matched *any* of them. Git resolves an attribute per path by the **last**
matching line, so a negation placed after a broad glob is how a repo says "this
subtree is generated, except this part". The reviewer discarded those negations
while parsing, which meant it silently skipped review of exactly the files a repo
had gone out of its way to keep visible.

`parseGitattributesGenerated` now returns ordered `GeneratedRule[]`
(`{pattern, generated}`) instead of a flat pattern list, keeping negations rather
than dropping them, and `isGenerated` scans in reverse and returns the first
matching rule's verdict. A line that never mentions the attribute is not a rule at
all, so it cannot shadow one. `RouterConfig.generatedPatterns` is renamed to
`generatedRules` to match what it now carries.

Found while onboarding `Khan/agent-settings` (Khan/agent-settings#48), whose
`.gitattributes` marks the installer-written `.claude/**`, `.codex/**`, `.cursor/**`
and `.pi/**` output generated and then un-marks `.claude/skills/**` and
`.pi/git/**` with a comment saying to keep them visible in diffs. Its
`new-repo-config` skill — executable prose that steers every Claude session in that
repo — resolved to `trivial (generated)` and was excluded from review; it now
resolves to `medium` and is reviewed.

Blast radius is narrow and one-directional (strictly more review, never less):
only a repo that actually writes a negation after a broader `=true` glob changes at
all. `Khan/actions` and `Khan/frontend` have no negations, and webapp's single one
(`services/ai-guide/cmd/componentgen/main.go linguist-generated=false`) exists to
counter Linguist's content heuristic rather than an earlier `.gitattributes` rule,
so no earlier rule matches that path and its classification is unchanged.
