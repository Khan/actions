import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {liveCase, producerOver, scriptedRunner} from "./live-ab-fixtures";
import {runArm, type ArmProduce} from "./live-ab";
import {withDispatchProgress} from "./live-ab-progress";
import type {LiveAgentRunner} from "./live-producer";

describe("live A/B progress lines", () => {
    let stderr: string[];
    let stdout: string[];
    beforeEach(() => {
        stderr = [];
        stdout = [];
        vi.spyOn(process.stderr, "write").mockImplementation(((
            chunk: string | Uint8Array,
        ) => {
            stderr.push(String(chunk));
            return true;
        }) as typeof process.stderr.write);
        vi.spyOn(process.stdout, "write").mockImplementation(((
            chunk: string | Uint8Array,
        ) => {
            stdout.push(String(chunk));
            return true;
        }) as typeof process.stdout.write);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("emits one line per dispatch end and one per case end, on stderr only", async () => {
        const {runner} = scriptedRunner();
        const cases = [liveCase("case-1"), liveCase("case-2")];
        await runArm("baseline", cases, producerOver("baseline", runner), {
            maxUsd: 10,
        });

        const lines = stderr
            .join("")
            .split("\n")
            .filter((l) => l !== "");
        expect(stdout).toEqual([]);
        // Two dispatches then the case line, twice.
        expect(lines.map((l) => l.split("] ")[1]?.split(":")[0])).toEqual([
            "correctness-reviewer (m)",
            "claim-validator (m)",
            "case done",
            "correctness-reviewer (m)",
            "claim-validator (m)",
            "case done",
        ]);
        expect(lines[0]).toBe(
            "[baseline/case-1] correctness-reviewer (m): $0.25, 3 turns, 1s, 12 tool calls",
        );
        // No tool-call count when the runner reports none.
        expect(lines[1]).toBe(
            "[baseline/case-1] claim-validator (m): $0.25, 3 turns, 1s",
        );
        expect(lines[2]).toBe(
            "[baseline/case-1] case done: verdict REQUEST_CHANGES (as expected), " +
                "caught bug, missed none, $0.50 this case, $0.50 so far (1/2 cases)",
        );
        expect(lines[5]).toBe(
            "[baseline/case-2] case done: verdict REQUEST_CHANGES (as expected), " +
                "caught bug, missed none, $0.50 this case, $1.00 so far (2/2 cases)",
        );
    });

    it("labels a repeat's arm with its suffix and names a verdict miss", async () => {
        const produceMiss: ArmProduce = async () => ({
            findings: [],
            validation: [],
            perAgent: [],
        });
        await runArm("candidate", [liveCase("case-1")], produceMiss, {
            maxUsd: 10,
            label: "candidate-r2",
        });
        expect(stderr.join("")).toBe(
            "[candidate-r2/case-1] case done: verdict APPROVE (expected " +
                "REQUEST_CHANGES), caught none, missed bug, $0.00 this case, " +
                "$0.00 so far (1/1 cases)\n",
        );
    });

    it("carries a refusal and a runner-visible error on the dispatch line", async () => {
        const failing: LiveAgentRunner = async () => ({
            output: "",
            usd: 0.03,
            turns: 1,
            wallMs: 2000,
            toolCalls: 0,
            refused: true,
            errorMessage: "usage policy",
        });
        const dispatch = withDispatchProgress(failing, {
            arm: "candidate",
            caseId: "case-1",
        });
        await dispatch({
            name: "security-reviewer",
            model: "m",
            prompt: "p",
            cwd: "/",
            maxTurns: 1,
            timeoutMs: 1,
        });
        expect(stderr.join("")).toBe(
            "[candidate/case-1] security-reviewer (m): $0.03, 1 turns, 2s, " +
                "0 tool calls, refused, error: usage policy\n",
        );
    });

    it("reports a dispatch that threw, then rethrows", async () => {
        const failing: LiveAgentRunner = async () => {
            throw new Error("boom");
        };
        const dispatch = withDispatchProgress(failing, {
            arm: "baseline",
            caseId: "case-1",
        });
        await expect(
            dispatch({
                name: "correctness-reviewer",
                model: "m",
                prompt: "p",
                cwd: "/",
                maxTurns: 1,
                timeoutMs: 1,
            }),
        ).rejects.toThrow("boom");
        expect(stderr.join("")).toBe(
            "[baseline/case-1] correctness-reviewer (m): dispatch threw: boom\n",
        );
    });
});
