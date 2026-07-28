---
"autofix": patch
---

Move the autofixer to Opus 5 (`claude-opus-5`), and drop the em dash from the commit-message template.

The pin is deliberately ahead of the reviewer's orchestrator (`claude-opus-4-8`): the reviewer's version is tied to its eval-suite calibration, autofix has no such tie, and writing the fix is the harder half of the pair.

No firewall override is needed. Claude 5 pricing has to be known to the api-proxy or it rejects the model with a 400 (the trap `review.md` documents for `claude-fable-5` on gh-aw <= v0.81.x), but this workflow compiles on gh-aw v0.83.4, whose default firewall is 0.27.42, past the 0.27.27 release that added curated Claude 5 pricing.

Also settles the `remote.origin.tagOpt=--no-tags` question left open by the fetch workaround: measured against Khan/webapp, adding it made the fetch dramatically **worse**, not better (85 s to completion without it; still transferring past 20 minutes with it, from an identical starting checkout, run back to back). It is not being added. The plausible reason is that suppressing tags removes reference points the server uses to negotiate the pack, but that is a hypothesis; the measurement is the part to trust.
