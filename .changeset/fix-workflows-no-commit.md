---
"fix-workflows": minor
---

Stop auto-committing fixed workflow files; instead print the commands the developer needs to run locally to fix lint violations and format their workflow files. Add a CLI entrypoint (`fix-workflows`) so devs can run the fixer via `npx`. Skip `*.lock.yml` files during processing.
