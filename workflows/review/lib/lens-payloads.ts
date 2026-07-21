/**
 * Consumer lens-payload validation (the per-lens payload seam).
 *
 * A consuming repo may carry `.github/aw/review/lenses/<lens>.md` files;
 * each is runtime-imported (optional form) into the matching reviewer
 * prompt. Because the imports are optional, a payload that nothing imports
 * fails SILENTLY: the file sits in the tree, the team believes its rules
 * are active, and no reviewer ever reads it. This module computes
 * fixed-format warnings for those cases; the router CLI appends them to
 * `routingConfig.warnings`, the same channel that surfaces ROUTING parse
 * warnings in the review body's note lines.
 *
 * Pure and dependency-light on purpose: the specialist-lens roster is a
 * parameter (it is derived in `router.ts`, which imports this module, so
 * importing it here would be a cycle).
 */

import type {Lens} from "./finding-schema";
import type {LensRule} from "./routing-config";

/** Where consumer lens payloads live. */
export const LENS_PAYLOAD_DIR = ".github/aw/review/lenses";

/** The deprecated alias for `lenses/correctness.md`, still imported. */
export const CORRECTNESS_ALIAS_PATH = ".github/aw/review/correctness-checks.md";

/**
 * Warnings for lens payloads that would be silently inert: an entry in
 * `lenses/` whose name matches no imported payload (a typo or an unknown
 * lens), a payload for a specialist lens no ROUTING rule ever routes, and
 * the deprecated correctness alias carried alongside its replacement.
 * `correctness` is valid alongside the specialists (the always-on
 * `correctness-reviewer` imports it) and is never flagged as unrouted.
 */
export const lensPayloadWarnings = (
    payloadFiles: readonly string[],
    lensRules: readonly LensRule[],
    correctnessAliasPresent: boolean,
    specialistLenses: readonly Lens[],
): string[] => {
    const warnings: string[] = [];
    const validNames = new Set<string>([...specialistLenses, "correctness"]);
    const routed = new Set<Lens>(lensRules.flatMap((rule) => rule.lenses));
    for (const file of payloadFiles) {
        const name = file.endsWith(".md") ? file.slice(0, -3) : file;
        if (!validNames.has(name) || !file.endsWith(".md")) {
            warnings.push(
                `lens payload ${LENS_PAYLOAD_DIR}/${file} matches no ` +
                    `imported payload (valid names: <specialist lens>.md ` +
                    `or correctness.md); no reviewer will read it`,
            );
        } else if (name !== "correctness" && !routed.has(name as Lens)) {
            warnings.push(
                `lens payload ${LENS_PAYLOAD_DIR}/${file} is inert: no ` +
                    `ROUTING rule routes lens=${name}, so that lens never ` +
                    `spawns in this repo`,
            );
        }
    }
    if (correctnessAliasPresent && payloadFiles.includes("correctness.md")) {
        warnings.push(
            `both ${LENS_PAYLOAD_DIR}/correctness.md and its deprecated ` +
                `alias ${CORRECTNESS_ALIAS_PATH} exist; both are imported, ` +
                `duplicating the correctness checks -- carry only ` +
                `${LENS_PAYLOAD_DIR}/correctness.md`,
        );
    }
    return warnings;
};
