---
"secure-network": patch
---

Fix intermittent DNS failures on GitHub-hosted runners caused by /etc/resolv.conf being a symlink to a tmpfs file managed by systemd-resolved. chattr +i is a no-op on tmpfs, so systemd-resolved could overwrite the file after setup. The symlink is now removed before writing, creating a real file on /etc (ext4) that chattr can lock.
