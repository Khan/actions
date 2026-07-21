---
"review": minor
---

Add the per-lens consumer payload seam. A consuming repo may now define
`.github/aw/review/lenses/<lens>.md` for any of the eleven specialist lenses, plus
`lenses/correctness.md` for the always-on `correctness-reviewer`; each file is
runtime-imported (optional form) into a new "Repo-specific rules and hunts" section
of the matching reviewer prompt, carrying that repo's surface-specific rules and
extra tri-state hunts. Lens names stay generic and shared; only payloads vary per
repo. Behavior-neutral for every current consumer: no consumer carries a payload
file yet, and a missing optional import inlines nothing at runtime.
`correctness-checks.md` remains imported as a deprecated alias for
`lenses/correctness.md` (frontend carries one today); repos should migrate the file
and carry at most one of the two. The eval's import resolution now matches
production for the optional form (missing resolves to empty, not the "(not
configured for this eval case)" note), so corpus case trees can carry payloads; the
required-form fallback note is unchanged. README documents the new surface and the
three-way contribution rule (shared skeleton vs lens payload vs skills) and fixes
two stale claims in the consumer-config section (the undocumented
`correctness-checks.md`, and the assertion that the optional import form was
dropped).
