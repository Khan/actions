---
"review": minor
---

Thumbs-sweep: opt-in reaction seeding and self-reaction filtering. With `seedReactions: true` in the sweep config, each sweep seeds one thumbs-up and one thumbs-down (from the bot) on any reviewer comment lacking them, so readers see the feedback affordance without opening the reaction picker. Feedback counts now exclude the bot's own reactions everywhere, so seeded nudges never trigger follow-ups or count as signal; a reaction with no attributed login still counts as a real user's. The port gains an optional `addReactions` method, required only when seeding is enabled (enabling it without an implementation fails loudly).
