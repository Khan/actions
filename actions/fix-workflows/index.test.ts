import {describe, expect, it} from "vitest";
import {isMap, isSeq, parseDocument} from "yaml";

import {
    DEFAULT_SETUP_ACTION,
    checkRunsOn,
    checkSteps,
    fixRunsOn,
    fixSteps,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YAML string and return the steps sequence from jobs.<id>.steps */
function parseWorkflowSteps(yaml: string) {
    const doc = parseDocument(yaml);
    const jobs = doc.get("jobs") as any;
    const job = jobs.items[0].value;
    const steps = job.get("steps");
    if (!isSeq(steps)) {
        throw new Error("Expected a steps sequence");
    }
    return {doc, steps};
}

/** Parse a YAML string and return the steps sequence from runs.steps (composite action) */
function parseCompositeSteps(yaml: string) {
    const doc = parseDocument(yaml);
    const runs = doc.get("runs") as any;
    const steps = runs.get("steps");
    if (!isSeq(steps)) {
        throw new Error("Expected a steps sequence");
    }
    return {doc, steps};
}

// ---------------------------------------------------------------------------
// fixSteps
// ---------------------------------------------------------------------------

describe("fixSteps", () => {
    it.each([
        [
            "returns false and leaves steps unchanged when checkout is already followed by secure-network with timeout-minutes",
            `
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Secure Network
        uses: ${DEFAULT_SETUP_ACTION}
        timeout-minutes: 5
      - name: Build
        run: pnpm build
`,
        ],
        [
            "returns false for a conditional checkout that is already followed by secure-network with timeout-minutes",
            `
jobs:
  build:
    steps:
      - name: Conditional Checkout
        uses: actions/checkout@v4
        if: github.event_name == 'pull_request'
      - name: Secure Network
        uses: ${DEFAULT_SETUP_ACTION}
        if: github.event_name == 'pull_request'
        timeout-minutes: 5
`,
        ],
    ])("%s", (_name, yaml) => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(yaml);
        const originalLength = steps.items.length;

        // Act
        const result = fixSteps(doc, steps);

        // Assert
        expect(result).toBe(false);
        expect(steps.items).toHaveLength(originalLength);
    });

    it("adds timeout-minutes: 5 to an existing secure-network step that is missing it", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Secure Network
        uses: ${DEFAULT_SETUP_ACTION}
`);

        // Act
        const result = fixSteps(doc, steps);

        // Assert
        expect(result).toBe(true);
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
            ]
        `);
    });

    it("inserts a secure-network step after a checkout that has no following setup", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Build
        run: pnpm build
`);

        // Act
        const result = fixSteps(doc, steps);

        // Assert
        expect(result).toBe(true);
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
              {
                "name": "Build",
                "run": "pnpm build",
              },
            ]
        `);
    });

    it("inserts setup steps after each of multiple checkouts missing setup", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: First Checkout
        uses: actions/checkout@v4
      - name: Some Step
        run: echo hello
      - name: Second Checkout
        uses: actions/checkout@v4
      - name: Final Step
        run: echo done
`);

        // Act
        const result = fixSteps(doc, steps);

        // Assert
        expect(result).toBe(true);
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "First Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
              {
                "name": "Some Step",
                "run": "echo hello",
              },
              {
                "name": "Second Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
              {
                "name": "Final Step",
                "run": "echo done",
              },
            ]
        `);
    });

    it("propagates the if condition from a conditional checkout to the inserted step", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Conditional Checkout
        uses: actions/checkout@v4
        if: github.event_name == 'pull_request'
      - name: Build
        run: pnpm build
`);

        // Act
        fixSteps(doc, steps);

        // Assert
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "if": "github.event_name == 'pull_request'",
                "name": "Conditional Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "if": "github.event_name == 'pull_request'",
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
              {
                "name": "Build",
                "run": "pnpm build",
              },
            ]
        `);
    });

    it("does not add if condition to setup step when checkout has no if condition", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
`);

        // Act
        fixSteps(doc, steps);

        // Assert
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
            ]
        `);
    });

    it("works for composite action steps the same as workflow steps", () => {
        // Arrange
        const {doc, steps} = parseCompositeSteps(`
runs:
  using: composite
  steps:
    - name: Checkout
      uses: actions/checkout@v4
    - name: Do Something
      run: echo hello
      shell: bash
`);

        // Act
        const result = fixSteps(doc, steps);

        // Assert
        expect(result).toBe(true);
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Secure Network",
                "timeout-minutes": 5,
                "uses": "Khan/actions@secure-network-v1",
              },
              {
                "name": "Do Something",
                "run": "echo hello",
                "shell": "bash",
              },
            ]
        `);
    });

    it("uses 'Setup' as the step name when the setup action is a local path", () => {
        // Arrange
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
`);

        // Act
        fixSteps(doc, steps, "./.github/actions/setup");

        // Assert
        expect(steps).toMatchInlineSnapshot(`
            [
              {
                "name": "Checkout",
                "uses": "actions/checkout@v4",
              },
              {
                "name": "Setup",
                "timeout-minutes": 5,
                "uses": "./.github/actions/setup",
              },
            ]
        `);
    });

    it("detects a path-based setup step without the leading ./ prefix", () => {
        // Arrange: step already has the setup action (written without ./ prefix)
        const {doc, steps} = parseWorkflowSteps(`
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup
        uses: .github/actions/setup
        timeout-minutes: 5
`);
        const originalLength = steps.items.length;

        // Act
        const result = fixSteps(doc, steps, "./.github/actions/setup");

        // Assert: no insertion because the setup step is already present
        expect(result).toBe(false);
        expect(steps.items).toHaveLength(originalLength);
    });
});

// ---------------------------------------------------------------------------
// checkSteps
// ---------------------------------------------------------------------------

describe("checkSteps", () => {
    it.each([
        [
            "returns false when there are no violations",
            `
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Secure Network
        uses: ${DEFAULT_SETUP_ACTION}
        timeout-minutes: 5
      - name: Build
        run: pnpm build
`,
            false,
        ],
        [
            "returns true when a checkout is not immediately followed by secure-network",
            `
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Build
        run: pnpm build
`,
            true,
        ],
        [
            "returns true when a secure-network step is missing timeout-minutes",
            `
jobs:
  build:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Secure Network
        uses: ${DEFAULT_SETUP_ACTION}
      - name: Build
        run: pnpm build
`,
            true,
        ],
        [
            "returns false when there are no checkout steps at all",
            `
jobs:
  build:
    steps:
      - name: Build
        run: pnpm build
`,
            false,
        ],
    ])("%s", (_name, yaml, expected) => {
        // Arrange
        const {steps} = parseWorkflowSteps(yaml);

        // Act
        const result = checkSteps(steps);

        // Assert
        expect(result).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// Helpers for runs-on tests
// ---------------------------------------------------------------------------

/** Parse a YAML string and return the first job's map node. */
function parseWorkflowJob(yaml: string) {
    const doc = parseDocument(yaml);
    const jobs = doc.get("jobs") as any;
    const job = jobs.items[0].value;
    if (!isMap(job)) {
        throw new Error("Expected a job map");
    }
    return job;
}

// ---------------------------------------------------------------------------
// checkRunsOn
// ---------------------------------------------------------------------------

describe("checkRunsOn", () => {
    it.each([
        [
            "returns false for the standard conditional expression",
            `
jobs:
  build:
    runs-on: "\${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}"
    steps: []
`,
            false,
        ],
        [
            "returns false for a large-runner conditional expression",
            `
jobs:
  build:
    runs-on: "\${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest-l' || 'ephemeral-runner' }}"
    steps: []
`,
            false,
        ],
        [
            "returns true for a plain ubuntu-latest string",
            `
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
`,
            true,
        ],
        [
            "returns true for a plain ubuntu-latest-l string",
            `
jobs:
  build:
    runs-on: ubuntu-latest-l
    steps: []
`,
            true,
        ],
    ])("%s", (_name, yaml, expected) => {
        // Arrange
        const job = parseWorkflowJob(yaml);

        // Act
        const result = checkRunsOn(job);

        // Assert
        expect(result).toBe(expected);
    });
});

// ---------------------------------------------------------------------------
// fixRunsOn
// ---------------------------------------------------------------------------

describe("fixRunsOn", () => {
    it("returns false and leaves runs-on unchanged when already using the conditional expression", () => {
        // Arrange
        const job = parseWorkflowJob(`
jobs:
  build:
    runs-on: "\${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}"
    steps: []
`);

        // Act
        const result = fixRunsOn(job);

        // Assert
        expect(result).toBe(false);
        expect(job.get("runs-on")).toBe(
            "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}",
        );
    });

    it("replaces ubuntu-latest with the conditional expression", () => {
        // Arrange
        const job = parseWorkflowJob(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
`);

        // Act
        const result = fixRunsOn(job);

        // Assert
        expect(result).toBe(true);
        expect(job.get("runs-on")).toBe(
            "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest' || 'ephemeral-runner' }}",
        );
    });

    it("replaces ubuntu-latest-l with the large-runner conditional expression", () => {
        // Arrange
        const job = parseWorkflowJob(`
jobs:
  build:
    runs-on: ubuntu-latest-l
    steps: []
`);

        // Act
        const result = fixRunsOn(job);

        // Assert
        expect(result).toBe(true);
        expect(job.get("runs-on")).toBe(
            "${{ vars.USE_GITHUB_RUNNERS == 'true' && 'ubuntu-latest-l' || 'ephemeral-runner' }}",
        );
    });
});
