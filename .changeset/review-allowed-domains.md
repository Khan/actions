---
"review": patch
---

Expand the `allowed-domains` allowlist for the review workflow's safe outputs so links we routinely use in PRs survive gh-aw's text-sanitization. Chosen from the domains that actually appear in our PR bodies and comments (surveyed across recent Khan/frontend PRs): GitHub, khanacademy.org (incl. per-PR deploy previews), khanacademy.dev, Jira/Confluence, Slack, Claude (claude.ai + claude.com), Figma, Google Docs, and Cursor. Entries are bare hosts, which match the host and all of its subdomains.
