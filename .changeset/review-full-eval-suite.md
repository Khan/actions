---
"review": minor
---

Add the full eval suite under `workflows/review/eval/`: a four-dataset corpus (incidents, synthetic mutations, golden PRs, known-clean, plus an adversarial holdout), five pure metrics (must-catch recall, golden precision, clean false-block, noise, confidence calibration with ECE), an LLM judge with an injected model seam pinned to Opus 4.8 (audit sampling and thumbs calibration included), and release gates (adversarial hard gate for automatic mode, overfitting advisory). The deterministic suite runs on every PR through the normal test runner (node-ci); the live judge runs weekly via `.github/workflows/review-eval-full.yml` and the committed `workflows/review/eval/live-judge.ts` entry point, reporting to the job summary.
