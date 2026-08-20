---
"review": minor
---

A 👎 on a bot finding now adjudicates it, exactly like resolving its thread: the staging reads each thread opener's THUMBS_DOWN reaction count, and a bot-opened thread with a downvoted opener joins the adjudicated suppression corpus whatever its resolution state, so the settled defect cannot re-post under fresh wording (blocking re-flags still always post, and a still-open downvoted thread stays in the open corpus, which keeps the verdict-floor bookkeeping). Previously the downvote channel the bot advertises (the thumbs sweep asks "why?" on exactly this signal) dead-ended in counters and changed nothing about what posts. Also documents the full feedback signal contract (reply / resolve / 👎 / hide) in the README.
