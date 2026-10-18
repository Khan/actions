---
"review": patch
---

Run the investigation-cap CLI directly with node instead of npx tsx. The
reviewer already runs on node 24, so its budget check doesn't need package
resolution or tsx's IPC socket. The CLI's entry guard now works with native
type stripping, and all three prompt invocations use the same command.
