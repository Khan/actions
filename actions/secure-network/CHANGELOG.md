# secure-network

## 1.1.0

### Minor Changes

-   eecb47a: Make setup faster.

    -   Read the GitHub Actions domains only from the bundled `github-meta.json`. Do not call the GitHub meta API. Unauthenticated calls from shared egress IPs got HTTP 403, and the retries took up to 18.5 s. A weekly workflow runs `gen-github-meta.sh` and opens a PR when the domains change.
    -   Remove the DNS cache prewarm.
    -   Run the final DNS check in parallel (16 lookups at a time).
    -   Start the script with `execFileSync` (no shell), so input values cannot inject commands. The shell does not expand `$VAR` in `conf-files` and `extra-domains` now. Use a GitHub expression or an absolute path.

## 1.0.4

### Patch Changes

-   4bdf82b: Fix intermittent DNS failures on GitHub-hosted runners caused by /etc/resolv.conf being a symlink to a tmpfs file managed by systemd-resolved. chattr +i is a no-op on tmpfs, so systemd-resolved could overwrite the file after setup. The symlink is now removed before writing, creating a real file on /etc (ext4) that chattr can lock.

## 1.0.3

### Patch Changes

-   907b1aa: Run apt-get update before installing packages to ensure package lists are current.

## 1.0.2

### Patch Changes

-   de6a3cb: Improve secure-network logging.

## 1.0.1

### Patch Changes

-   38786a6: A bug fix to handle multi-line inputs better.

## 1.0.0

### Major Changes

-   652acb0: Remove errant comment, bump major version.

## 0.2.0

### Minor Changes

-   dbf9aeb: Add secure-network shared GitHub Action for DNS firewall setup
