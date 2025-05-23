# filter-files

## 2.1.0

### Minor Changes

-   c17f036: Add a matched_any output to filter-files

## 2.0.0

### Major Changes

-   319f6c4: Filtering out #comments in multiline input lists
-   22f9e6d: Change behavior of "negative globs" to match .gitignore

## 1.0.0

### Major Changes

-   67d07a3: Update to actions that use Node 20

## 0.5.0

### Minor Changes

-   9b8a083: Globs match conjunctively (AND) when matchAllGlobs is true.

## 0.4.0

### Minor Changes

-   0f71fde: Added optional parameter to assert that _every_ filter condition passes to include a file. This switches from an inclusive disjunction to conjunction.

## 0.3.1

### Patch Changes

-   b65ce8c: Fixes a bug in parsing glob patterns

## 0.3.0

### Minor Changes

-   4559c88: Add 'extensions' and 'globs' options to filter-files action for more flexibility

## 0.2.1

### Patch Changes

-   7511dd2: Better error reporting for misconfigured arguments

## 0.2.0

### Minor Changes

-   3362f97: Add the 'invert' option, to return unmatched paths instead of matched ones.
-   16133a3: Allow the "files" and "extensions" list to be newline-separated or comma-separated. Also trim spaces after splitting by commas, so you can put spaces after commas if you want.

## 0.1.0

### Minor Changes

-   524c68f: Add support for filtering by directory
