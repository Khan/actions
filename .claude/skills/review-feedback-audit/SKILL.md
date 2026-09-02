---
name: review-feedback-audit
description: Audit the PR review workflow's posted output and human feedback in a consumer repo over a time window (typically since a reviewer deploy). Computes volume, verdict mix, label mix, verbosity, duplication at three grains, suppression notes, and human feedback (reactions, thread replies, and, in windows predating the follow-up retirement, thumbs-sweep follow-up replies), then maps each finding to an open Khan/actions PR or a new-PR candidate. Invoke with a consumer repo, a cutoff timestamp, and optionally the bot login.
---

# Review quality and feedback audit

Measure what the reviewer actually posted in a consumer repo and how humans
responded, over a bounded window. The typical trigger is a reviewer deploy:
set the cutoff to the deploy time and audit everything since. The output is
a report plus a list of improvement candidates, each mapped to an existing
Khan/actions PR or flagged as new work.

Collection and analysis (Steps 1-4) are read-only against GitHub (GET
requests only) and dependency-free: `bash`, `jq`, `gh`. Step 5 is a
separate write phase (posting PR comments) that needs access beyond a
GET-only broker. The skill was first executed by hand against Khan/webapp
for the 2026-08-11/12 window; the commands below encode that procedure.

## Required inputs

1. **Consumer repo**, e.g. `Khan/webapp`.
2. **Cutoff timestamp** in UTC ISO-8601, e.g. `2026-08-11T16:00:00Z`.
   Convert from local deploy time first (`date -d "<local>" -u
   +%Y-%m-%dT%H:%M:%SZ`).
3. **Bot login** (optional): the account the reviewer posts as, default
   `github-actions[bot]`. Must match the repo's `REVIEW_BOT_LOGIN` if set.

```sh
REPO=Khan/webapp
CUTOFF=2026-08-11T16:00:00Z
BOT='github-actions[bot]'
WORK=$(mktemp -d)
```

## Step 1: collect

All list endpoints filter `since` on `updated_at`, not `created_at`, so
every collection re-filters on `created_at >= $CUTOFF` (or `submitted_at`
for reviews) after fetching.

**Inline review comments** (the bot's findings plus everyone's replies):

```sh
gh api --paginate "repos/$REPO/pulls/comments?since=$CUTOFF&per_page=100" \
  | jq -s '[.[][]]' > "$WORK/pc.json"
jq --arg bot "$BOT" --arg c "$CUTOFF" \
  '[.[] | select(.user.login==$bot and .created_at >= $c)]' \
  "$WORK/pc.json" > "$WORK/bot_inline_raw.json"
```

**Issue comments** (guidance comments, CI noise, and, in windows predating
the follow-up retirement, sweep follow-ups). The
reviewer's guidance comment is identified by the engine-appended
`gh-aw-agentic-workflow` marker, not by any bot-authored marker: the ingest
sanitizer strips agent-written HTML comments (see Known constraints).

```sh
gh api --paginate "repos/$REPO/issues/comments?since=$CUTOFF&per_page=100" \
  | jq -s '[.[][]]' > "$WORK/ic.json"
jq --arg bot "$BOT" --arg c "$CUTOFF" \
  '[.[] | select(.user.login==$bot and .created_at >= $c
    and (.body | contains("gh-aw-agentic-workflow")))]' \
  "$WORK/ic.json" > "$WORK/guidance.json"
```

**Reviews.** There is no repo-wide `since` endpoint for reviews: find the
PRs updated in the window via search, then list each PR's reviews and filter.

```sh
gh api --paginate \
  "search/issues?q=repo:$REPO+is:pr+updated:%3E%3D$CUTOFF&per_page=100" \
  --jq '.items[].number' > "$WORK/prs.txt"
# Search caps at 1,000 results regardless of pagination; detect truncation.
total=$(gh api "search/issues?q=repo:$REPO+is:pr+updated:%3E%3D$CUTOFF&per_page=1" \
  --jq .total_count)
[ "$total" -le 1000 ] ||
  echo "WARNING: $total PRs match but Search caps at 1000; split the window" >&2
> "$WORK/reviews.tsv"
while read -r pr; do
  gh api --paginate "repos/$REPO/pulls/$pr/reviews?per_page=100" \
    --jq "[.[] | select(.user.login==\"$BOT\"
        and .submitted_at >= \"$CUTOFF\")]
      | .[] | [$pr, .id, .state, .submitted_at, (.body|length),
        (.body|test(\"review-v[0-9]\"))] | @tsv" \
    < /dev/null >> "$WORK/reviews.tsv"
done < "$WORK/prs.txt"
```

Redirecting stdin from `/dev/null` inside the loop matters: `gh` can consume
the loop's stdin and truncate the PR list. The last column marks rows whose
body carries the v1.14.0+ version footer; Step 3's run count keys on it.

**Reactions.** The listing's `reactions` object gives counts; fetch the
detail endpoint only for comments with `total_count > 0`, and exclude the
bot's own reactions. Nudge seeding (the bot reacting to its own comments)
is a planned feature; do not assume its status, and keep the filter either
way (it is correct before and after):

```sh
jq -r '.[] | select(.reactions.total_count > 0) | .id' \
  "$WORK/bot_inline_raw.json" | while read -r id; do
  gh api "repos/$REPO/pulls/comments/$id/reactions" \
    --jq "[.[] | select(.user.login != \"$BOT\")
      | [$id, .user.login, .content] | @tsv] | .[]" < /dev/null
done > "$WORK/reactions.tsv"
```

Guidance comments are issue comments, so their reactions live on a
different endpoint; collect them too or the reaction tally silently covers
inline findings only:

```sh
jq -r '.[] | select(.reactions.total_count > 0) | .id' \
  "$WORK/guidance.json" | while read -r id; do
  gh api "repos/$REPO/issues/comments/$id/reactions" \
    --jq "[.[] | select(.user.login != \"$BOT\")
      | [$id, .user.login, .content] | @tsv] | .[]" < /dev/null
done >> "$WORK/reactions.tsv"
```

**Human replies.** A reply's `in_reply_to_id` points at the thread opener.
Collect non-bot replies in the window, then resolve any parent id that is
not in the window's bot-comment set (a reply to an OLDER bot comment) with
a direct fetch, keeping only bot-authored parents:

```sh
jq --arg bot "$BOT" --arg c "$CUTOFF" -r \
  '[.[] | select(.user.login != $bot and (.in_reply_to_id? != null)
    and .created_at >= $c)]
  | .[] | [.in_reply_to_id, .id, .user.login, .created_at,
    (.pull_request_url|split("/")|last)] | @tsv' \
  "$WORK/pc.json" 2>/dev/null | sort -u > "$WORK/replies.tsv"
comm -23 <(cut -f1 "$WORK/replies.tsv" | sort -u) \
  <(jq -r '.[].id' "$WORK/bot_inline_raw.json" | sort) \
  | while read -r cid; do
  gh api "repos/$REPO/pulls/comments/$cid" \
    --jq '[.id, .user.login] | @tsv' < /dev/null
done | awk -F'\t' -v bot="$BOT" '$2==bot {print $1}' \
  > "$WORK/old_bot_parents.txt"
# replies.tsv still holds every non-bot reply repo-wide, including replies
# in human-opened threads; keep only rows whose parent is bot-authored.
cat <(jq -r '.[].id' "$WORK/bot_inline_raw.json") \
  "$WORK/old_bot_parents.txt" | sort -u > "$WORK/bot_parent_ids.txt"
awk -F'\t' 'NR==FNR {ok[$1]=1; next} ok[$1]' \
  "$WORK/bot_parent_ids.txt" "$WORK/replies.tsv" > "$WORK/bot_replies.tsv"
```

Every later step reads `bot_replies.tsv`; `replies.tsv` is an intermediate.

## Step 2: classify

**Conventional-Comment labels.** Parse the label prefix off each bot body:
`issue`, `suggestion`, `question`, `note`, `nitpick`, `thought`, plus
variants like `(non-blocking, documentation)` and
`(non-blocking, best-practice)`. In windows predating the follow-up
retirement, bodies with no label are usually thumbs-sweep follow-ups (next
paragraph); in windows after it, an unlabeled bot body is an anomaly worth
reading rather than bucketing:

```sh
jq '[.[] | {id, pr: (.pull_request_url|split("/")|last|tonumber), path,
  line, created_at, in_reply_to_id, len: (.body|length),
  label: ((.body
    | capture("\\*\\*(?<l>[a-z]+ \\([^)]*\\)|[a-z]+):?\\*\\*")).l?
    // "FOLLOWUP"),
  reactions, body}]' \
  "$WORK/bot_inline_raw.json" > "$WORK/bot_inline.json"
```

**Thumbs-sweep follow-ups (historical only).** The sweep's "why?" follow-up
was retired and the sweep itself then deleted entirely (see the
`workflows/review` CHANGELOG entries for both); PRs reviewed after the
retirement release never carry follow-ups.
When the audit window predates the retirement, follow-ups carry the
`review-thumbs-followup` marker (a sweep-posted comment survived the
sanitizer because the sweep posted through the plain API, not through safe
outputs). Count them separately from findings, and note that a follow-up
posted as a review shows up in `reviews.tsv` as a `COMMENTED` review; the
run-count rule in Step 3 keeps it out of run totals.

**Reason replies (historical only).** Follow-ups offered a closed
vocabulary: `incorrect`, `unimportant`, `unclear`, `duplicate`. It survives
in code only as the permanently-unpopulated `DownvoteReason` type in
`workflows/review/eval/judge.ts`, kept to type historical labels. For
pre-retirement windows, match replies to follow-ups by thread and record
the latency from downvote to follow-up and from follow-up to reply; skip
both metrics for windows after the retirement (there is nothing to measure).

**Human replies**: classify each thread's outcome by reading the exchange:
`accepted` (author changed code or agreed), `declined` (author rejected with
a reason), `answered` (bot asked, author answered, no change requested).
Thread replies reach a maintainer only through this skill or manual reading;
no automated job consumes them (the weekly report is `counters-report.ts`
and has no reply handling), so treat an unaddressed reply as unseen, not
triaged.

## Step 3: compute the metrics

- **Runs and verdicts**: count review runs by the v1.14.0+ version footer
  (the `review-v<version>` segment in the review body's collapsed
  `<details>` block), not by review events: the autofix workflow's thread
  replies arrive as implicit empty `COMMENTED` review events (as did sweep
  follow-ups, pre-retirement), so a raw `reviews.tsv` row count overstates
  runs. Verdict mix (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`) over
  the footer-bearing rows. For windows predating v1.14.0 no footer exists;
  fall back to review events minus sweep follow-ups and say so in Caveats.
- **Volume**: bot inline comments per PR and per run; guidance comments.
- **Label mix**: count per label; blocking vs non-blocking split.
- **Verbosity**: mean / median / p90 / max body chars over top-level bot
  comments, and the share carrying a sketch block:

```sh
jq '[.[] | select(.label != "FOLLOWUP") | .len]
  | {n: length, mean: (add/length|floor),
     median: (sort | .[length/2|floor]),
     p90: (sort | .[(length*0.9|floor)]), max: max, min: min}' \
  "$WORK/bot_inline.json"
jq '[.[] | select(.body
  | contains("A sketch, not a committable replacement"))] | length' \
  "$WORK/bot_inline.json"
```

- **Duplication, three grains**:
  1. Byte-identical bodies in one run (`group_by(.body) | map(select(length
     > 1))`); the in-run clusterer should have merged these.
  2. Same-run same-root-cause clusters: distinct anchors, one underlying
     defect (read the bodies; no mechanical test).
  3. Cross-run families: the same mechanism re-derived across runs on
     different anchors or files. These are what defect-identity suppression
     (path plus similarity floors) misses when the variants span files;
     list each family with its thread ids.
- **Suppression notes**, parsed from review bodies: `not re-posted (already
  tracked)`, `shed under the ... run budget`, and the `N of M prior review
  threads` accountability lines. These show which mitigations fired.
- **Feedback**: reactions by kind and reactor; human replies by outcome
  class; for pre-retirement windows only, sweep follow-up latency and
  reason-reply latency.
- **Attribution**: check each posted review body and guidance comment for a
  version marker or footer, and report presence per body.

## Known constraints

- **Hidden HTML comments are sanitizer-stripped.** gh-aw's safe-output
  ingest sanitizer (`removeXmlComments`) deletes every agent-written HTML
  comment, so the absence of `<!-- pr-reviewer:... -->` markers in posted
  bodies is expected unless the checkout being audited ships a visible
  (non-HTML-comment) footer; check for `version-footer.ts` in the lib
  rather than assuming either state. Do not read marker absence alone as a
  version-attribution regression; the engine-appended
  `gh-aw-agentic-workflow` marker is what identifies the guidance comment.
- **GraphQL may be unavailable.** Under a GET-only gh broker, the GraphQL
  endpoint (needed for `reviewThreads` resolution state) is blocked. Thread
  resolution is a positive signal column of this audit; when GraphQL is
  blocked, state explicitly in the report that thread-resolution counts are
  unavailable. Do not approximate them from
  reply activity.
- **`since` is an `updated_at` filter.** Always re-filter on
  `created_at`/`submitted_at`; an old comment edited inside the window
  otherwise pollutes the sample.
- **Search caps at 1,000 results.** `search/issues` returns at most 1,000
  items even with `--paginate`, silently. The `prs.txt` collection block
  compares `total_count` against the cap; when it warns, split the window
  into `updated:A..B` sub-ranges or report every reviews-derived count as
  a lower bound.
- **Sentinel strings live in lib code.** The markers this audit greps for
  are defined in Khan/actions source, and a zero count is indistinguishable
  from a renamed marker: "A sketch, not a committable replacement" in
  `workflows/review/lib/submission.ts`, the suppression note phrasing in
  `workflows/review/lib/dispatch.ts`, and the `gh-aw-agentic-workflow`
  marker appended by the gh-aw engine. Before trusting any zero
  measurement, re-derive the string from the checkout being audited. The
  `review-thumbs-followup` marker and the downvote-reason vocabulary were
  deleted from the lib with the follow-up retirement; when auditing a
  pre-retirement window, re-derive the marker from a pre-retirement tag's
  `lib/thumbs-sweep.ts` (the CHANGELOG entry describes the retirement but
  does not quote the deleted strings). The downvote-reason vocabulary needs
  no tag: it survives in the checkout as `DownvoteReason` in
  `workflows/review/eval/judge.ts`.

## Step 4: report

Use these sections, in order:

1. **Window**: repo, cutoff, collection time, bot login.
2. **Volume and verdicts**: runs, verdict mix, comments per PR, label mix.
3. **Quality**: blocking findings and their outcomes; notable catches;
   misses (a finding the author correctly refuted, with the refutation).
4. **Verbosity**: the stats above, sketch-block share, review-body and
   guidance-comment sizes.
5. **Duplication**: one subsection per grain, with ids.
6. **Human feedback**: reactions, replies by outcome, and (pre-retirement
   windows only) sweep follow-up loop latencies.
7. **Caveats**: GraphQL availability, marker expectations, sample-size
   limits, anything unverifiable.

## Step 5: map findings to work items

List the open Khan/actions PRs and map every report finding to one of:
an existing PR (cite the number and what it covers), a gap in an existing
PR (comment on that PR with the measured data rather than widening it),
or a new-PR / design-note candidate:

```sh
gh pr list --repo Khan/actions --state open --limit 50 \
  --json number,title,isDraft
```

Post measured data points as PR comments where they strengthen an open
PR's motivation (the gh shim rejects inline `--body`; write the body to a
file and pass `--body-file`). End the report with the mapped list so the
operator can prioritize.
