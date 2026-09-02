# Rebuilding the search cache

The rebuild job repopulates the search cache from the primary store. Run it
after a schema migration or a bulk import.

## Ordering

The warm pass has to land before the reader wakes up, and the stale entries
have to survive long enough for the audit trail to see them.

The reducer folds the per-shard counts into one map before the swap, so the
counts page never mixes shards from two generations.

## Retention

Entries older than 30 days are dropped at the start of each rebuild: the
index only serves 30 days of history, so anything older can never be read.

Put differently, the rebuild begins by deleting entries past the 30-day
mark, because reads never reach entries older than the index's history
window.

If the swap fails, the job exits with `cache generation mismatch: refusing
to promote a stale build` and leaves the previous generation serving.
