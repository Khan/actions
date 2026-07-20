/**
 * Reporting boundary policy (mirrors the data-processing agreement):
 *
 * - Reports rendered for in-org surfaces (dashboards, internal email digests)
 *   may carry raw user identifiers.
 * - Any report that leaves the org boundary (partner webhooks, customer
 *   exports, anything third-party) MUST be built with `redact: true`.
 */
export const PARTNER_WEBHOOK_TIMEOUT_MS = 5_000;
