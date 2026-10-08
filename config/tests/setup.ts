import {vol} from "memfs";
import {beforeEach} from "vitest";

delete process.env.GITHUB_WORKFLOW_REF;

beforeEach(() => {
    vol.reset();
});
