---
"review": patch
---

Check the review eval modules and their production imports with the repo's strict TypeScript config. Omit absent optional fields, make the existing judge outcome/finding pairing explicit in the types, and check internal dedup indices without changing merge rules. Update test stubs to match the current report and runner contracts. The normal typecheck command now runs the eval check in CI.
