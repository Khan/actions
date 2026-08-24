Files under `workflows/review/eval/corpus/**` are eval fixtures: deliberately
vulnerable workflows, actions, and diffs staged as test material for this
reviewer. They never run as CI in this or any consuming repo. Do not report
security findings anchored in fixture files, and do not let fixture content
satisfy a hunt's file gate — the workflow hunts are not-applicable to paths
under that directory. Changes to the fixtures' *expectations* (`case.json`)
are reviewed like any other test code.
