---
"apply-terraform-plan": patch
---

Regenerate data-source side-effect artifacts before applying a saved plan, so applies that (re)upload a Cloud Function/Cloud Run source bundle no longer fail on a fresh runner.

The plan and apply jobs run on different runners. During `generate-terraform-plan`, an `archive_file` data source writes the function source zip to disk; the saved `tfplan.binary` records the resulting `google_storage_bucket_object` (`source = <local zip path>`). But `terraform apply <saved-plan>` does **not** re-evaluate data sources, so on the fresh apply runner that zip was never written and the apply fails with `open .../<job>-function.zip: no such file or directory`. This only surfaces when the archive actually changes (i.e. a source-code change) — metadata/IAM-only applies don't read the missing file, which is why it stayed hidden.

The apply action now runs a throwaway `terraform plan` after `init` (non-`auto_approve` mode only) to re-materialize those local files, then applies the saved binary unchanged. The step is best-effort (`continue-on-error`): if it can't run (e.g. a required `TF_VAR_*` is only set in the plan workflow), the apply proceeds exactly as before, so this can never regress an apply that works today.
