---
"review": minor
---

The accountability recap stops re-quoting non-blocking threads it already recapped: a kept non-blocking thread whose opener URL appears in any prior review body renders as label + link (no excerpt), fresh threads render full and lead the collapsed block, and the block's summary counts the repeats ("N non-blocking threads still open (M previously reported)"). Blocking threads are never damped; a thread with no staged URL renders full (fail toward more information). Measured on webapp#41290, where the same four threads were re-quoted in full across 25 re-reviews and the drumbeat read as the bot re-arguing threads the author was already looking at.
