---
"review": minor
---

review: trim the sub-agent tool surface to Read/Grep/Bash, and window Read

Two tools leave `createReviewTools`, raised in review on #305: LS wrapped
`ls -la` verbatim and added nothing over sandboxed Bash, and Glob's
`find -path` emulation was wrong rather than merely limited (`*` matched
across `/`, so a reviewer asking for `src/*.ts` silently received nested
files too). Directory listing and file finding go through Bash, where the
model owns the semantics of its own command. Every tool runs through the
same sandboxed executor, so the named tools that remain earn their place on
model ergonomics, not containment: Read for windowed, line-numbered file
views, Grep because structured params avoid the shell-quoting failure class.

Read gains `offset`/`limit` windowing. Previously a large file was silently
truncated at the output cap and its tail was unreachable, a recall defect;
the window keeps `cat -n` line numbers so findings still anchor on real
lines, and a partial view says which lines of how many it shows.

The eval's measured arms now run this production surface unrestricted
(previously they were pinned to Read/Grep/Glob, a surface production never
ran), so the A/B measures what production ships, by construction. The
re-anchoring run for the new surface is on the PR.
