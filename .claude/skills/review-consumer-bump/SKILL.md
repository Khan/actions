---
name: review-consumer-bump
description: Bump the shared PR reviewer (`Khan/actions` `workflows/review`) pin, and optionally the autofix pin, in every consuming repo. One PR per consumer; a 3-way merge that preserves each repo's LOCAL OVERRIDE blocks; verification with the version-matched consumer-config checker. Use when a `review-v<version>` release should roll out, or when a single consumer's pin is stale. Invoke with the target version and, if applicable, the autofix version.
---

# Bump the shared reviewer pin in consuming repos

Produce **one PR per consuming repo** that moves the installed
`.github/workflows/review.md` (and optionally `autofix.md`) to a new release
tag, without losing that repo's local overrides and without trusting any tool
to do the merge for you.

The reference bumps are the 2026-08-20 set:
[`Khan/kore-marketplace#11`](https://github.com/Khan/kore-marketplace/pull/11),
[`Khan/agent-settings#76`](https://github.com/Khan/agent-settings/pull/76),
[`Khan/webapp#41661`](https://github.com/Khan/webapp/pull/41661),
[`Khan/actions#356`](https://github.com/Khan/actions/pull/356). Every pitfall
below was hit live in that session.

## What stays human

Confirm with the operator before opening any PR:

1. **The consumer set and the target version(s).** Step 1's search is
   discovery, not authorization: name the repos and the version hop it found
   and get an explicit yes before branching in any of them.
2. **Force-pushing an open PR** (Step 6's mid-rollout update). Rewriting
   commits under someone's in-flight review is the operator's call.

## Step 1: discover the consumers

Do not work from a remembered list; discover the consumers each time. Every
install carries a `source:` line at the bottom of the installed file's
frontmatter, so an org-wide code search finds them all (including
`Khan/actions` itself, which installs its own copy). Percent-encode the whole
query (the raw `+`-separated form 400s intermittently) and filter to the
installed path client-side, since the phrase also matches lock files and the
reviewer's own README and lib:

```sh
gh api 'search/code?q=org%3AKhan%20%22workflows%2Freview%2Freview.md%40review-v%22&per_page=100' \
    | jq -r 'if .total_count > 100 then error("over 100 hits; re-run with --paginate") else . end
             | .items[] | select(.path == ".github/workflows/review.md") | .repository.full_name' \
    | sort -u
```

The `total_count` guard is not decoration: the command reads a single
100-item page, and without the check a rollout past 100 consumers silently
drops the overflow.

The `@review-v` phrase has a blind spot: an install whose `source:` pins a raw
commit SHA instead of a tag does not match it. This is not hypothetical:
Khan/frontend sat pinned to `54f804c` (the review-v1.1.1 tag commit) for 18
minors and was invisible to this search, found 2026-08-24 only by the sweep
below. A SHA pin is exactly what a `gh aw add ...@<tag>` records (it resolves
the tag) and what the banned `gh aw update` writes, so expect more of them.
After the phrase search, re-check with the pin-agnostic sweep: list the org's
active repos and probe each one's installed file directly.

```sh
gh api --paginate 'orgs/Khan/repos?per_page=100' --jq '.[] | select(.archived==false) | .name' > /tmp/repos.txt
while read -r r; do gh api "repos/Khan/$r/contents/.github/workflows/review.md" --jq '.content' </dev/null 2>/dev/null | base64 -d | grep -H --label="Khan/$r" '^source: Khan/actions/workflows/review/review.md@'; done < /tmp/repos.txt
```

The sweep is also the fallback when code search is unavailable at all (some
sandbox brokers allowlist only owner-scoped REST endpoints and block
`search/code` and the `gh search` verb; the sweep is plain GETs). Two traps,
both hit live: under the Khan github broker, `gh api` paths must NOT start
with a leading slash (`/orgs/Khan/repos` is rejected as not owner-scoped,
`orgs/Khan/repos` passes), and the `gh` shim eats the `while read` loop's
stdin, so the `</dev/null` on the inner call is what keeps the loop from
exiting after one repo.

The same search with the autofix phrase
(`workflows%2Fautofix%2Fautofix.md%40autofix-v`, path
`.github/workflows/autofix.md`) enumerates autofix installs, and the
difference between the two sets is the repos where autofix is a fresh install
rather than a bump. Code search has a low per-minute rate limit and indexes
default branches only (an install sitting in an open PR will not appear), so
pause between the two queries and sanity-check the result against the repos
you expect. Read each consumer's current pin from its own `source:` line;
consumers drift, so do not assume they are all on the same version. Do not
trust the pin blindly either: resolve it in a `Khan/actions` checkout
(`git tag --points-at <sha>`, or `git describe --tags --match 'review-v*'`)
and, for anything more than a couple of minors stale, diff the installed copy
against the pinned content before choosing a merge base. Khan/frontend's pin
named the review-v1.1.1 commit while the installed file carried 255 diff lines
of unmarked local edits (a hand-authored re-review fast path, no LOCAL
OVERRIDE markers anywhere); a merge based on the pin alone would have
misattributed all of it. An install that stale, or one whose local edits
upstream has since superseded, is an onboarding refresh
(`.claude/skills/review-onboarding/SKILL.md`), not a bump.

## Do not use `gh aw update`

It is the obvious tool and it fails twice, both observed live:

1. It does not recognize the `review-v<version>` tag scheme as a release tag
   (not bare semver), logs "Treating review-v1.13.0 as branch", and repins to
   the **head commit of main** as a raw SHA instead of the target tag.
2. Its 3-way merge emptied the consumer's `review.md` to 0 bytes in one run
   against `Khan/kore-marketplace` (gh-aw v0.85.4).

The manual merge below is what the tool would do if it worked.

Both failures were observed on gh-aw v0.85.4 and neither is filed upstream,
so this ban carries no expiry: before trusting a newer gh-aw release with a
bump, reproduce both failures on a scratch install first.

## Step 2: the merge

Work in a fresh clone of the consumer, on a new branch. From a `Khan/actions`
checkout, with the installed copy as ours:

1. `git -C <actions> fetch --tags`: a tag cut during the rollout will not be
   in a stale clone, and steps 2-3 fail silently on a tag the clone lacks.
2. `git -C <actions> show review-v<current>:workflows/review/review.md > /tmp/base.md`
   (the consumer's **current** pin; the base).
3. `git -C <actions> show review-v<target>:workflows/review/review.md > /tmp/new.md`
   (the **target** tag; theirs).
4. `test -s /tmp/base.md && test -s /tmp/new.md`: a tag the clone does not
   have makes `git show` fail while the `>` redirect still leaves a 0-byte
   file, and `git merge-file` reads an empty theirs as "upstream deleted the
   file". That is the same emptying this skill exists to prevent, and the
   conflict-marker gate in Step 5 will not catch it.
5. `git merge-file .github/workflows/review.md /tmp/base.md /tmp/new.md`
6. Bump the `source:` line by hand: it exists only in the installed copy, so
   the merge never touches it. The `pre-agent-steps` checkout `ref:` needs no
   hand edit; the release flow rewrites it inside the tag, so it arrives from
   theirs.

Conflicts appear exactly where an upstream edit lands adjacent to a `<REPO>
LOCAL OVERRIDE` block. Resolution is always the same shape: keep the override,
take the new upstream lines around it. Zero conflicts is the common case (2 of
the 4 reference bumps merged clean; the other 2 each had one conflict where an
upstream insertion landed against the raised `max-ai-credits`).

Before merging, inventory the installed copy's override blocks
(`grep -c "LOCAL OVERRIDE" .github/workflows/review.md`) and read what each
one does; after merging, re-run the count and confirm every block survived.
Overrides observed in the wild: replaced trigger blocks (manual `/review` via
`issue_comment` instead of auto-on-push), disabled `observability:` blocks in
repos without the Sentry secrets, and raised `max-ai-credits` values with
their `REVIEW_MAX_AI_CREDITS` env mirror (the two stay in sync per the
upstream comment).

## Step 3: autofix (if applicable)

The `autofix-v<version>` tag file ships install-ready: the release flow writes
its own `source:` and `ref:` lines into it. No consumer carried local autofix
edits as of 2026-08-20 (webapp's installed copy was byte-identical to its
tag), but confirm that still holds rather than assuming it: diff the installed
`autofix.md` against its currently pinned tag and check it is clean apart from
the pin lines. When it is, a bump or a fresh install is a verbatim `cp` of the
tag file; when it is not, run the same base/theirs/ours `git merge-file` as
Step 2, with the same override inventory before and after. Nothing downstream
catches a clobbered autofix override (the pins test covers `review.md` only),
and autofix pushes commits to consumer PRs, so the cheap diff is worth it.

A fresh install additionally requires the review workflow already installed
and the `ANTHROPIC_API_KEY` / `KHAN_ACTIONS_BOT_TOKEN` secrets. Both are
already referenced by any repo running the reviewer; confirm by name with
`gh secret list -R <repo>` if in doubt, never by value.

Known oddity: an installed pin can name a tag that does not exist on the
remote (one consumer was pinned to `autofix-v0.0.0`; the tag was never
pushed). Treat a nonexistent pin as "content matches whichever real tag diffs
clean apart from the pin lines" and move on.

## Step 4: recompile

Run `gh aw compile` in the consumer with current stable gh-aw. Expected side
effects, each observed on v0.85.4:

- `.github/aw/actions-lock.json` moves the gh-aw setup actions to the
  compiler's version. Keep it.
- The compile **strips `merge=ours`** from the `.gitattributes` lock-file
  line. Revert with `git checkout -- .gitattributes` after every compile; the
  repo authored that merge driver deliberately.
- gh-aw v0.85.x no longer generates `agentics-maintenance.yml` and deletes it.
  Keep the deletion and remove its now-stale `.gitattributes` line, but only
  after the final compile: the `git checkout` above discards every
  uncommitted edit to `.gitattributes`, this removal included.
- `'engine.model' is deprecated` warnings come from the shared file and are
  upstream's to fix. Do not run `gh aw fix` in a consumer.

While in the consumer: if it still carries `review-feedback.yml` (the retired
thumbs sweep), delete it in the same bump PR; Khan/webapp#41685 is the
reference deletion. `review-counters.yml` stays.

## Step 5: verify

1. No conflict markers: `grep -n "^<<<<<<<" .github/workflows/review.md`.
2. The pricing overlay is live: `providers` must appear inside **both**
   awf-config payloads of `review.lock.yml`. The second payload writes its
   JSON with backslash-escaped quotes, so one pattern cannot see both; count
   them separately. `grep -c '"providers"'` returns 2 (the unescaped payload
   plus the `GH_AW_INFO_MODEL_COSTS` env line, which does not count) and
   `grep -c '\\"providers\\"'` returns 1 (the escaped payload). Presence in
   `GH_AW_INFO_MODEL_COSTS` alone means the overlay is NOT live
   (Khan/actions#314 documents why).
3. Run the consumer-config checker **from a checkout of the target tag**, not
   whatever tag you had lying around: a version-skewed checker produces
   phantom warnings (checking 1.17.0 pins with the 1.16.0 checker added one
   spurious warning per repo). `--repo` takes a **path** to the consumer
   checkout, not a repo name; the checker fails loudly on a nonexistent path
   (Khan/actions#372), so a name like `Khan/webapp` dies with an error naming
   the path instead of reporting everything missing:

   ```sh
   git -C <consumer> ls-files | node -r @swc-node/register \
       workflows/review/lib/check-consumer-config.ts --repo <consumer-path> --files-from -
   ```

   (`npx tsx` per the README also works where unix sockets are available;
   the `-r @swc-node/register` form works everywhere the repo's own tests
   do.) Name the surviving warnings in the PR body and say they predate the
   change.
4. In `Khan/actions` itself, run the full suite. `review-pins.test.ts`
   requires every hunk of divergence between the installed copy and the
   pinned release to carry `KHAN/ACTIONS LOCAL OVERRIDE`. An upstream
   insertion can split a previously-adjacent override into its own unmarked
   hunk (1.16.0's `max-turn-cache-misses` did this to the
   `REVIEW_MAX_AI_CREDITS` mirror); the fix is a marker comment on the
   orphaned override, never a weaker test. `Khan/actions` also installs
   `review-canary.md`, whose prompt body and `source:` line
   `review-canary.test.ts` holds byte-identical to the installed `review.md`,
   so after merging and compiling `review.md` run `pnpm run sync-canary`
   (Khan/actions#411) to re-derive it and recompile its lock, then restore
   `.gitattributes` again. A bump that skips this fails CI on main.

## Step 6: the PRs

One per repo. Each body names: the version hop and what the release notes say
it brings, the overrides that were kept, the compile side effects, the checker
verdict with pre-existing warnings called out, and the jira link (the
`~/khan/plans` convention: the body ends with
`[KORE-nnn](https://khanacademy.atlassian.net/browse/KORE-nnn)`, keyed to the
task in that repo's per-tree `tasks.md` that owns the rollout; the `gh`
wrapper enforces this on `gh pr create` in Khan-org repos). If a release
lands mid-rollout, update open PRs in
place (force-push the rewritten commits) rather than stacking a second bump
commit, and say so in a PR comment. Edit the title and body for the new
version **before** the force-push, not after: the push is what re-triggers
the reviewer, and a round that starts against the old body blocks on "the
PR says vX but the diff pins vY" (kore-marketplace#24 and agent-settings#105
both did, on the 1.25.0 rewrite, with the body edited 2 minutes after the
push). Most installs trigger only on push, so that block then needs a manual
dismissal or another push to clear.
