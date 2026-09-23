# Pinned sanitizer test fixture

The 6 files under `gh-aw/actions/` are byte-for-byte copies from `setup/js/` in [github/gh-aw-actions at 2709137ea6c5b0e19aa621454dc643ea8dc526b1](https://github.com/github/gh-aw-actions/tree/2709137ea6c5b0e19aa621454dc643ea8dc526b1/setup/js), the gh-aw v0.85.4 runtime used by the reported review failures. `LICENSE` preserves the upstream license. `manifest.json` records SHA-256 hashes, checked in the runtime tests.

These fixtures let local and CI tests execute the real sanitizer offline, including its transitive dependencies. Don't format or hand-edit them. Update them from an explicitly pinned upstream commit and regenerate the manifest when adding coverage for a new runtime version.

Test setup points `RUNNER_TEMP` here. Production never loads this directory or falls back to it. It loads the runner's own pinned `${RUNNER_TEMP}/gh-aw/actions/sanitize_content_core.cjs`, which is read-only to the agent. That preserves consumer ownership of the gh-aw version rather than introducing a second production pin.
