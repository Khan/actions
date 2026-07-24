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
and carry at most one of the two, and the alias is removed in the next major
release. Payloads are additive by contract: the lens prompts state that payload
rules never relax or override the shared rules, which win on any conflict. The
router now warns (through `routingConfig.warnings`, surfaced in the review body's
note lines) when a payload would be silently inert: a filename matching no imported
payload, a specialist payload no ROUTING rule routes, the correctness alias carried
alongside its replacement, the alias carried at all (a deprecation nudge ahead of
its removal), or a `lenses` path that is not a readable directory (which degrades
to a warning instead of crashing the router CLI). The eval's import resolution now matches
production for the optional form (missing resolves to empty, not the "(not
configured for this eval case)" note), so corpus case trees can carry payloads; the
required-form fallback note is unchanged. README documents the new surface and the
three-way contribution rule (shared skeleton vs lens payload vs skills) and fixes
two stale claims in the consumer-config section (the undocumented
`correctness-checks.md`, and the assertion that the optional import form was
dropped).
