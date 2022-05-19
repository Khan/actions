# @Khan/actions

A monorepo for shared github actions.

Currently only composite actions are supported, although supporting nodejs actions probably wouldn't be too hard. If your script is simple, you can do a composite action that uses `actions/github-script`, see the `filter-files` action for an example.

## How does the monorepo work?

Github doesn't support putting actions in subdirectories, so we need to do some fancy work here. Inspired by [gitpkg](https://github.com/ramasilveyra/gitpkg), we "publish" versions of our actions to 'bare tags' in this repo. So the tag `filter-files-v0.0.1` would only contain the files for the `filter-files` action, and thus github is perfectly happy for us to reference it as `uses: @Khan/actions#filter-files-v0.0.1`.

Actions that depend on other actions within this repo (with e.g. `uses: filter-files`) will have the references automatically converted to the appropriated pinned reference (e.g. `Khan/actions#filter-files-v0.0.1`) as part of the publish process.

## How does changeset play in?

Changeset helps us track what needs to be published, and automatically produces a changelog so we know what changed in a given release.
