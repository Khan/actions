import {describe, it, expect} from "vitest";
import * as realFs from "node:fs";
import path from "node:path";
import {execSync} from "node:child_process";

// generate-terraform-plan uploads the binary plan to a GCS object whose path
// apply-terraform-plan later reconstructs from its own inputs. The slug logic
// is necessarily duplicated inline in both composite actions: published tags
// contain a single action's directory (see utils/publish.ts), so the two
// actions cannot share a helper file. These tests pin the copies to each
// other; if either drifts, apply reconstructs a different object path than
// generate wrote and every apply 404s.

const readAction = (name: string): string =>
    realFs.readFileSync(
        path.join(__dirname, "..", "actions", name, "action.yml"),
        "utf-8",
    );

const generateYml = readAction("generate-terraform-plan");
const applyYml = readAction("apply-terraform-plan");

const extractLines = (source: string, pattern: RegExp): string[] =>
    source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => pattern.test(line));

const SLUG_PIPELINE = /^slug=\$\(printf '%s' .+\| tr -c /;
const HASH_SUFFIX = /^slug="\$\{slug\}-\$\(printf '%s' .+sha256sum/;

// Run one of the extracted slug pipelines against a sample input by swapping
// the GitHub expression for an environment variable. This executes the exact
// bytes from the action files, not a retyped copy.
const runSlugPipeline = (pipelineLine: string, input: string): string => {
    const command = pipelineLine
        .replace(/^slug=\$\((.*)\)$/, "$1")
        .replace('"${{ inputs.terraform_path }}"', '"$TF_PATH"');
    return execSync(command, {
        env: {...process.env, TF_PATH: input},
        encoding: "utf-8",
    });
};

describe("terraform plan GCS object key", () => {
    it("uses byte-identical slug pipelines everywhere", () => {
        const generateSlugs = extractLines(generateYml, SLUG_PIPELINE);
        const applySlugs = extractLines(applyYml, SLUG_PIPELINE);

        // One in generate's upload step; two in apply (download step and the
        // pre-existing cleanup-branch naming, which uses the same pipeline).
        expect(generateSlugs).toHaveLength(1);
        expect(applySlugs).toHaveLength(2);

        for (const line of [...generateSlugs, ...applySlugs]) {
            expect(line).toBe(generateSlugs[0]);
        }
    });

    it("uses byte-identical collision-hash suffixes in both actions", () => {
        const generateHash = extractLines(generateYml, HASH_SUFFIX);
        const applyHash = extractLines(applyYml, HASH_SUFFIX);

        expect(generateHash).toHaveLength(1);
        expect(applyHash).toHaveLength(1);
        expect(applyHash[0]).toBe(generateHash[0]);
    });

    it("uses a fixed object filename segment on both sides", () => {
        // The filename segment must not depend on the two actions'
        // independently configurable local filename inputs
        // (plan_file_binary vs plan_file_path).
        const generateObject = extractLines(generateYml, /^object="gs:\/\//);
        const applyObject = extractLines(applyYml, /^object="gs:\/\//);

        expect(generateObject).toHaveLength(1);
        expect(applyObject).toHaveLength(1);
        expect(generateObject[0]).toMatch(/\/tfplan\.binary"$/);
        expect(applyObject[0]).toMatch(/\/tfplan\.binary"$/);
    });

    it.each([
        ["terraform/culture-cron", "terraform-culture-cron"],
        [
            "github-actions-runner/terraform/runner",
            "github-actions-runner-terraform-runner",
        ],
        ["a//b", "a-b"],
        ["/leading/and/trailing/", "leading-and-trailing"],
        ["with_underscore.dot", "with_underscore.dot"],
        // These two normalize identically; the sha256 suffix appended after
        // this pipeline is what keeps their object keys distinct.
        ["terraform/foo", "terraform-foo"],
        ["terraform-foo", "terraform-foo"],
    ])("slugs %s to %s", (input, expected) => {
        const [pipeline] = extractLines(generateYml, SLUG_PIPELINE);
        expect(runSlugPipeline(pipeline, input)).toBe(expected);
    });
});
