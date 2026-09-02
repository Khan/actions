---
"review": patch
---

review: pin sub-agent and prose-judge effort at high explicitly

Behavior-neutral: the Claude Agent SDK already defaults opus-4.6+ to
adaptive thinking at effort high, and that default is what every production
review has run. Pinned now because the default was invisible enough that
the Pi harness port (PR #406) sent an explicit thinking-disabled instead,
turning off the thinking production reviewers run with, and a full harness
A/B went by without anyone noticing. Every reviewer runs at a blanket high
until per-role levels earn their own measurement.
