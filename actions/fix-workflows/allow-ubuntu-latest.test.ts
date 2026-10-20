import * as fs from "fs";
import {describe, expect, it} from "vitest";
import {isMap, parseDocument} from "yaml";

import {
    DEFAULT_SETUP_ACTION,
    checkJob,
    checkRunsOn,
    fixRunsOn,
    processJob,
} from "./index.ts";

/**
 * The opt-in `allowUbuntuLatest` exemption from the runs-on rule, split from
 * index.test.ts to keep that file inside its 1000-line cap.
 *
 * The exemption only relaxes the runs-on rule: a plain `ubuntu-latest` job must
 * still have its checkout followed by the setup action. Before the exemption
 * existed, a plain `ubuntu-latest` always failed the runs-on check, so nothing
 * needed to pin the setup rule on its own for that case; with the exemption on,
 * the setup rule is the only check left on those jobs.
 */

/** Parse a YAML string and return the document and first job's map node. */
function parseWorkflowJobWithDoc(yaml: string) {
    const doc = parseDocument(yaml);
    const jobs = doc.get("jobs") as any;
    const job = jobs.items[0].value;
    if (!isMap(job)) {
        throw new Error("Expected a job map");
    }
    return {doc, job};
}

function jobWithRunsOn(runsOn: string) {
    return parseWorkflowJobWithDoc(`
jobs:
  build:
    runs-on: ${runsOn}
    steps: []
`).job;
}

const UNPROTECTED_UBUNTU_LATEST_JOB = `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Build
        run: pnpm build
`;

describe("checkRunsOn with allowUbuntuLatest", () => {
    it.each([
        ["ubuntu-latest", false, true],
        ["ubuntu-latest", true, false],
        ["ubuntu-latest-l", true, true],
        ["ubuntu-24.04", true, true],
        [
            "\"${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}\"",
            true,
            false,
        ],
    ])(
        "runs-on %s with allowUbuntuLatest=%s is non-compliant: %s",
        (runsOn, allowUbuntuLatest, expected) => {
            // Arrange
            const job = jobWithRunsOn(runsOn);

            // Act
            const result = checkRunsOn(job, allowUbuntuLatest);

            // Assert
            expect(result).toBe(expected);
        },
    );
});

describe("fixRunsOn with allowUbuntuLatest", () => {
    it("wraps a plain ubuntu-latest by default", () => {
        // Arrange
        const job = jobWithRunsOn("ubuntu-latest");

        // Act
        const result = fixRunsOn(job);

        // Assert
        expect(result).toBe(true);
        expect(job.get("runs-on")).toBe(
            "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}",
        );
    });

    it("leaves a plain ubuntu-latest unchanged when allowed", () => {
        // Arrange
        const job = jobWithRunsOn("ubuntu-latest");

        // Act
        const result = fixRunsOn(job, true);

        // Assert
        expect(result).toBe(false);
        expect(job.get("runs-on")).toBe("ubuntu-latest");
    });

    it("still wraps other plain runner names when allowed", () => {
        // Arrange
        const job = jobWithRunsOn("ubuntu-latest-l");

        // Act
        const result = fixRunsOn(job, true);

        // Assert
        expect(result).toBe(true);
        expect(job.get("runs-on")).toBe(
            "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest-l' || 'ephemeral-runner' }}",
        );
    });
});

describe("the setup rule on an allowed ubuntu-latest job", () => {
    it("processJob still inserts the secure-network step", () => {
        // Arrange
        const {doc, job} = parseWorkflowJobWithDoc(
            UNPROTECTED_UBUNTU_LATEST_JOB,
        );

        // Act
        const result = processJob(doc, job, {
            shouldFixRunsOn: true,
            allowUbuntuLatest: true,
        });

        // Assert
        expect(result).toBe(true);
        expect(job.get("runs-on")).toBe("ubuntu-latest");
        expect(job.toJSON().steps[1]).toMatchObject({
            name: "Secure Network",
            uses: DEFAULT_SETUP_ACTION,
            "timeout-minutes": 5,
        });
    });

    it("checkJob still reports a missing secure-network step", () => {
        // Arrange
        const {job} = parseWorkflowJobWithDoc(UNPROTECTED_UBUNTU_LATEST_JOB);

        // Act
        const result = checkJob(job, {
            shouldFixRunsOn: true,
            allowUbuntuLatest: true,
        });

        // Assert
        expect(result).toBe(true);
    });

    it("checkJob passes once the secure-network step is in place", () => {
        // Arrange
        const {doc, job} = parseWorkflowJobWithDoc(
            UNPROTECTED_UBUNTU_LATEST_JOB,
        );
        const options = {shouldFixRunsOn: true, allowUbuntuLatest: true};
        processJob(doc, job, options);

        // Act
        const result = checkJob(job, options);

        // Assert
        expect(result).toBe(false);
    });
});

describe("action.yml", () => {
    const actionYml = fs.readFileSync(
        new URL("./action.yml", import.meta.url),
        "utf-8",
    );

    it("passes the allow-ubuntu-latest input to the fixer", () => {
        expect(actionYml).toContain(
            "allowUbuntuLatest: ${{ inputs.allow-ubuntu-latest == 'true' }}",
        );
    });

    it("includes --allow-ubuntu-latest in the fix instructions", () => {
        expect(actionYml).toContain(
            "inputs.allow-ubuntu-latest == 'true' && ' --allow-ubuntu-latest'",
        );
    });
});
