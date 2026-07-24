import {describe, it, expect} from "vitest";

import {
    CORRECTNESS_ALIAS_PATH,
    LENS_PAYLOAD_DIR,
    lensPayloadWarnings,
} from "./lens-payloads.ts";
import {SPECIALIST_LENSES} from "./router.ts";
import type {Lens} from "./finding-schema.ts";
import type {LensRule} from "./routing-config.ts";

/**
 * Lens-payload validation tests. The failure mode under test is silence: a
 * payload file that nothing imports (typo, unknown name) or that an imported
 * lens never reads (no ROUTING rule spawns it) is invisible at runtime, so
 * the only surface where the author learns about it is these warnings. The
 * CLI wiring (readdir + append to routingConfig.warnings) is pinned in
 * router.test.ts.
 */

const routed = (lens: Lens): LensRule[] => [
    {pattern: "src/**", lenses: [lens]},
];

const warningsFor = (
    payloadFiles: readonly string[],
    lensRules: readonly LensRule[] = [],
    aliasPresent = false,
): string[] =>
    lensPayloadWarnings(
        payloadFiles,
        lensRules,
        aliasPresent,
        SPECIALIST_LENSES,
    );

describe("lensPayloadWarnings", () => {
    it("is silent for a routed specialist payload and correctness.md", () => {
        expect(
            warningsFor(
                ["security-auth.md", "correctness.md"],
                routed("security-auth"),
            ),
        ).toEqual([]);
    });

    it("warns on a filename matching no imported payload", () => {
        const warnings = warningsFor(
            ["security_auth.md", "README.md", "notes.txt"],
            routed("security-auth"),
        );
        expect(warnings).toHaveLength(3);
        for (const warning of warnings) {
            expect(warning).toContain("matches no imported payload");
        }
        expect(warnings[0]).toContain(`${LENS_PAYLOAD_DIR}/security_auth.md`);
    });

    it("warns on a specialist payload no ROUTING rule routes", () => {
        const warnings = warningsFor(
            ["money-payments.md"],
            routed("security-auth"),
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("lens=money-payments");
        expect(warnings[0]).toContain("inert");
    });

    it("never flags correctness.md as unrouted (always-on reviewer)", () => {
        expect(warningsFor(["correctness.md"])).toEqual([]);
    });

    it("warns when correctness.md and its deprecated alias coexist", () => {
        const warnings = warningsFor(["correctness.md"], [], true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(CORRECTNESS_ALIAS_PATH);
    });

    it("nudges on the alias alone (deprecated, dropped next major)", () => {
        const warnings = warningsFor([], [], true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("deprecated alias");
        expect(warnings[0]).toContain(`${LENS_PAYLOAD_DIR}/correctness.md`);
    });

    it("does not double-warn when both correctness files exist", () => {
        const warnings = warningsFor(["correctness.md"], [], true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("both");
    });

    it("accepts every specialist lens name as a payload filename", () => {
        for (const lens of SPECIALIST_LENSES) {
            expect(warningsFor([`${lens}.md`], routed(lens))).toEqual([]);
        }
    });
});
