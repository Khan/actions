# Locking

The rebuild takes one advisory lock per shard for the duration of the swap,
so two rebuilds of the same shard cannot interleave.

Readers never take the shard lock: they read the last published generation
and rely on the rebuild to swap atomically.

## Shard counters

The reducer folds the per-shard counts into one map while the shard lock is
held, so a rebuild never publishes a page that mixes two generations.

We call this the two-clock rule: the wall clock orders user events, and the
generation counter orders rebuilds. A page is valid only when both clocks
agree, and every consumer checks the generation counter before trusting a
row's wall-clock timestamp.
