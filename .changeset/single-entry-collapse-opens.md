---
"review": patch
---

A one-entry collapsed section renders `<details open>` with a count-only summary instead of a closed collapse carrying the named-top tag. At N=1 the summary's top-entry preview is the whole payload (subjects rarely hit the 120-char truncation cap), so the closed form rendered the observation twice, summary and body, and read as a stray uncollapsed comment (Khan/actions#387's review did exactly that with its single documentation observation). The section stays a `<details>` block because the autofix's body-sourced work list slices the section by its `<summary>` line and closing `</details>` (`workflows/autofix/lib/collapsed.ts`); the summary regex keys on the `<summary>` text, so both forms parse unchanged, and the render/parse round-trip test happens to shed exactly one claim, pinning the open form. Sections with two or more entries are unchanged.

Expected output-shape effect: reviews whose collapsed tail holds exactly one entry (5 of the 29 collapsed sections across the bot's reviews on this repo's last 40 PRs) render that section expanded by default under "Lower-confidence observations (1)" (or "Non-blocking observations (1)"), with the entry visible without a click and no longer duplicated in the summary line. Body length shrinks slightly for those reviews (the summary drops the top tag); nothing else moves.
