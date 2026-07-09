---
"review": minor
---

Failure scenario required on every finding. Each finding (not just blocking ones) now carries a concrete `failure_scenario`: the specific inputs or state and the wrong outcome they produce. The field is required in the structured finding schema (`FINDING_SCHEMA_VERSION` 2), emitted by every producer (label-shape reviewers and all 11 specialist lenses), and carried verbatim into `claims.json`; the `claim-validator` attacks exactly that stated scenario, and a scenario too vague to check caps at `plausible`. Every corpus fixture is migrated with a hand-written failure scenario.
