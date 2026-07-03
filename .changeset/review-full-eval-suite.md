---
"review": minor
---

Add the full eval suite under `workflows/review/eval/`: a four-dataset corpus (incidents, synthetic mutations, golden PRs, known-clean, plus an adversarial holdout), five pure metrics (must-catch recall, golden precision, clean false-block, noise, confidence calibration with ECE), an LLM judge with an injected model seam pinned to Opus 4.8 (audit sampling and thumbs calibration included), release gates (adversarial hard gate for automatic mode, overfitting advisory), and a version stamp hashing prompts and config into the existing PR marker as the single drift surface. A scheduled full-suite workflow (deterministic run plus opt-in live judge) is staged at `.github-staging/review-eval-full.yml`.
