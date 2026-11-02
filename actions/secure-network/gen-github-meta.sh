#!/bin/bash
# Generate a JSON file with the domains that are allowed to be accessed by GitHub Actions.
#
# secure-network.js reads only this file; it does not call the meta API.
# .github/workflows/secure-network-update-github-meta.yml runs this script weekly.
#
# This is used to restrict network access to only the domains that are needed for the action to work.
# See: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#allowing-access-to-the-internet
#
# Usage:
#   ./gen-github-meta.sh
#
# This will generate a JSON file with the domains that are allowed to be accessed by GitHub Actions.
# The file will be saved in the same directory as the script.
set -euo pipefail

# Unauthenticated calls from shared IPs often get HTTP 403.
auth=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

# Write to a temp file, so a failed call does not empty the real file.
out="$(dirname "$0")/github-meta.json"
trap 'rm -f "$out.tmp"' EXIT
curl -sf ${auth[@]+"${auth[@]}"} https://api.github.com/meta | jq '{domains: {actions_inbound: .domains.actions_inbound}}' > "$out.tmp"
# secure-network.js exits on an empty list, so do not publish one.
jq -e '(.domains.actions_inbound.full_domains | length) > 0' "$out.tmp" > /dev/null
mv "$out.tmp" "$out"
