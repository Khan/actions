# secure-network

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
