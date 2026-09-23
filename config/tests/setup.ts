import {vol} from "memfs";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, vi} from "vitest";

beforeEach(() => {
    vol.reset();
    // Exercise the real pinned sanitizer offline through its production loader.
    vi.stubEnv(
        "RUNNER_TEMP",
        fileURLToPath(
            new URL(
                "../../workflows/review/test-fixtures/sanitizer/",
                import.meta.url,
            ),
        ),
    );
});

afterEach(() => vi.unstubAllEnvs());
