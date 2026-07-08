---
"review": minor
---

Bound reviewer investigation (R9): sub-agents get explicit instructions for cheap targeted verification (grep callers, trace the call chain, one targeted check per finding), and `workflows/review/lib/investigation-cap.ts` enforces a deterministic per-finding and per-run tool-call cap sourced from the router's run budget. Over-cap calls are refused with fixed reason codes and refusals never mutate state.
