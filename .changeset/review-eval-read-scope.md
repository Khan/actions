---
"review": patch
---

review eval: scope reviewers to the staged case, and write their transcripts

The live A/B runs on a machine that also holds this repo, which holds every
case's must-catch spec and the scorer, and nothing stopped a reviewer from
reading them. On the Pi harness branch a gemini reviewer did (found the repo
with `find /`, read its own case.json, another case's, and live-match.ts, 37
of 42 calls on one case), and the SDK arm on main was open the same way: its
`allowedTools` list only pre-approved Read/Grep/Glob, so under
`bypassPermissions` every default tool including Bash stayed reachable.

The runner now restricts the toolset with `tools`, denies through a
PreToolUse hook both any tool outside Read/Grep/Glob and any read whose path
resolves outside the staged case (checkout plus context), counts the denials
per agent into the report even when the attempt times out (a new
"Reads denied outside the staged case" row, plus a section naming the
reviewer when nonzero), and writes one transcript per dispatch under the
runner's temp dir, uploaded as `live-ab-transcripts`. Every live workflow
starts with `live-runner.ts --probe-read-scope`, one Haiku call that fails
the job if an out-of-scope read goes through. The README's read protocol now
says to read at least one transcript per arm before trusting a delta, and
names pre-scope runs as not isolated from the corpus.
