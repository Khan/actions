#!/bin/bash
# Generate a JSON file with the domains that are allowed to be accessed by GitHub Actions.
#
# This is only used as a fallback incase talking to Github's API doesn't work.
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

curl -sf https://api.github.com/meta | jq '{domains: {actions_inbound: .domains.actions_inbound}}' > "$(dirname "$0")/github-meta.json"
