import {describe, expect, it} from "vitest";

import {
    AUTOFIX_SCOPES,
    findingLabelsForScope,
    isLoopEligible,
    labelForToken,
    resolveCommand,
    resolveScope,
    SCOPE_LABELS,
    SCOPE_TOKENS,
    UNIMPLEMENTED_LABELS,
    UNIMPLEMENTED_TOKENS,
} from "./scope.ts";
import {
    BLOCKING_LABELS,
    DOCUMENTATION_LABEL,
    NON_BLOCKING_LABELS,
} from "../../review/lib/render-comment.ts";

describe("resolveScope", () => {
    it("reports none when no autofix label is present", () => {
        expect(resolveScope(["skip-ai-review", "bug"])).toEqual({
            status: "none",
        });
    });

    it("arms a single scope", () => {
        const result = resolveScope(["autofix: blocking"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["blocking"]);
        expect(result.request.labels).toEqual(["autofix: blocking"]);
        expect(result.request.findingLabels).toEqual([...BLOCKING_LABELS]);
    });

    it("unions both scopes and orders them canonically", () => {
        // Labels supplied in the reverse of AUTOFIX_SCOPES order.
        const result = resolveScope(["autofix: nits", "autofix: blocking"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["blocking", "nits"]);
        expect(result.request.findingLabels).toEqual([
            ...BLOCKING_LABELS,
            ...NON_BLOCKING_LABELS,
        ]);
    });

    it("ignores non-autofix labels alongside an autofix one", () => {
        const result = resolveScope(["bug", "autofix: nits", "priority"]);
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["nits"]);
    });

    it("rejects a label on an axis this version does not implement", () => {
        const result = resolveScope(["autofix: blocking", "autofix: loop"]);
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.labels).toEqual(["autofix: loop"]);
        expect(result.reason).toContain("cadence");
    });

    it("rejects rather than ignores an unrecognised autofix label", () => {
        const result = resolveScope(["autofix: everything"]);
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.reason).toContain("unrecognised");
        // The message tells the author what they could have used instead.
        expect(result.reason).toContain("autofix: blocking");
    });

    it("rejects when an unimplemented label is present even with a valid one", () => {
        // Guards the silent-drop failure: honouring the blocking half of
        // `blocking + loop` would look like a loop that stopped after one run.
        expect(resolveScope(["autofix: nits", "autofix: human"]).status).toBe(
            "rejected",
        );
    });
});

describe("the label vocabulary", () => {
    it("keeps every known label inside the shared namespace", () => {
        for (const label of [
            ...Object.keys(SCOPE_LABELS),
            ...Object.keys(UNIMPLEMENTED_LABELS),
        ]) {
            expect(label.startsWith("autofix: ")).toBe(true);
        }
    });

    it("never lets a label mean two things", () => {
        for (const label of Object.keys(SCOPE_LABELS)) {
            expect(UNIMPLEMENTED_LABELS[label]).toBeUndefined();
        }
    });

    it("covers every scope with exactly one label", () => {
        expect(Object.values(SCOPE_LABELS).sort()).toEqual(
            [...AUTOFIX_SCOPES].sort(),
        );
    });
});

describe("isLoopEligible", () => {
    // The constraint most likely to be violated by whoever adds the cadence
    // axis: non-blocking findings have no fixed point, so they cannot loop.
    it("allows blocking scope to loop", () => {
        expect(isLoopEligible("blocking")).toBe(true);
    });

    it("forbids nits from ever looping", () => {
        expect(isLoopEligible("nits")).toBe(false);
    });

    // Docs looks convergent and is not, mechanically: a docs fix's `+` lines
    // are comment text, which is the documentation reviewer's own subject
    // matter, so they land in the next cycle's newly-changed-code scope by
    // construction (webapp#41207: 5 of 5 threads fixed, three fresh
    // documentation findings minted on the prose the fixer had just written).
    // Deleting instead of rewriting does converge, by erasing the subject
    // matter (webapp#41204 left `staleAfter` undocumented). Permanently
    // ineligible, not pending measurement; see scope.ts for the full argument.
    it("forbids docs from looping, whichever half the fixer favours", () => {
        expect(isLoopEligible("docs")).toBe(false);
    });
});

describe("findingLabelsForScope", () => {
    it("maps each scope onto the reviewer's own taxonomy", () => {
        expect(findingLabelsForScope("blocking")).toEqual(BLOCKING_LABELS);
        expect(findingLabelsForScope("nits")).toEqual(NON_BLOCKING_LABELS);
        expect(findingLabelsForScope("docs")).toEqual([DOCUMENTATION_LABEL]);
    });

    it("keeps the two classes disjoint", () => {
        const blocking = new Set<string>(findingLabelsForScope("blocking"));
        for (const label of findingLabelsForScope("nits")) {
            expect(blocking.has(label)).toBe(false);
        }
    });

    // The containment the flat label namespace cannot show: arming `nits`
    // already includes every docs thread, so `nits + docs` is just `nits`.
    // `docs` earns its token by being the narrowing, not by adding anything.
    it("makes docs a strict subset of nits", () => {
        const nits = new Set<string>(findingLabelsForScope("nits"));
        for (const label of findingLabelsForScope("docs")) {
            expect(nits.has(label)).toBe(true);
        }
        expect(findingLabelsForScope("docs").length).toBeLessThan(
            findingLabelsForScope("nits").length,
        );
    });

    // A docs run must never be able to touch a thread that blocks the merge.
    it("never puts a blocking label in docs scope", () => {
        const blocking = new Set<string>(BLOCKING_LABELS);
        for (const label of findingLabelsForScope("docs")) {
            expect(blocking.has(label)).toBe(false);
        }
    });
});

describe("resolveCommand", () => {
    it("reports none for a comment that is not an autofix command", () => {
        expect(resolveCommand("looks good to me").status).toBe("none");
        expect(resolveCommand("/review").status).toBe("none");
    });

    it("does not match a command that is only a prefix of another word", () => {
        expect(resolveCommand("/autofixer please").status).toBe("none");
    });

    it("arms blocking scope for a bare command", () => {
        const result = resolveCommand("/autofix");
        expect(result.status).toBe("armed");
        if (result.status !== "armed") {
            return;
        }
        expect(result.request.scopes).toEqual(["blocking"]);
        expect(result.request.surface).toBe("command");
    });

    it("arms the scopes named as arguments", () => {
        const result = resolveCommand("/autofix nits");
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.scopes).toEqual(["nits"]);
    });

    it("unions multiple arguments and orders them canonically", () => {
        const result = resolveCommand("/autofix nits blocking");
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.scopes).toEqual(["blocking", "nits"]);
    });

    it("tolerates a trailing CRLF", () => {
        // The exact shape that silently killed /review in Khan/webapp#40943:
        // the GitHub web UI appends \r\n when you press Enter after a command.
        const result = resolveCommand("/autofix blocking\r\n");
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.scopes).toEqual(["blocking"]);
    });

    it("tolerates a bare command with a trailing CRLF", () => {
        expect(resolveCommand("/autofix\r\n").status).toBe("armed");
    });

    it("tolerates leading whitespace and tabs between arguments", () => {
        const result = resolveCommand("  /autofix\tblocking   nits  ");
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.scopes).toEqual(["blocking", "nits"]);
    });

    it("reads arguments from the command line only, ignoring later prose", () => {
        const result = resolveCommand(
            "/autofix blocking\n\nbut please keep the existing naming",
        );
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.scopes).toEqual(["blocking"]);
    });

    it("rejects an unimplemented axis and quotes the command form", () => {
        const result = resolveCommand("/autofix loop");
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.surface).toBe("command");
        expect(result.reason).toContain("cadence");
        expect(result.labels).toEqual(["/autofix loop"]);
    });

    it("rejects an unrecognised argument", () => {
        const result = resolveCommand("/autofix everything");
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
            return;
        }
        expect(result.reason).toContain("unrecognised");
        expect(result.reason).toContain("/autofix blocking");
    });

    it("never asks a command-armed run to remove labels", () => {
        const result = resolveCommand("/autofix blocking");
        if (result.status !== "armed") {
            throw new Error("expected armed");
        }
        expect(result.request.labels).toEqual([]);
    });
});

describe("the two surfaces agree", () => {
    // The whole reason both funnel through one resolver: a token must not mean
    // one thing as a label and another as a command.
    it("resolves the same scopes from either surface", () => {
        for (const [labels, command] of [
            [["autofix: blocking"], "/autofix blocking"],
            [["autofix: nits"], "/autofix nits"],
            [["autofix: blocking", "autofix: nits"], "/autofix blocking nits"],
        ] as const) {
            const fromLabel = resolveScope(labels);
            const fromCommand = resolveCommand(command);
            if (
                fromLabel.status !== "armed" ||
                fromCommand.status !== "armed"
            ) {
                throw new Error(`expected both armed for ${command}`);
            }
            expect(fromCommand.request.scopes).toEqual(
                fromLabel.request.scopes,
            );
            expect(fromCommand.request.findingLabels).toEqual(
                fromLabel.request.findingLabels,
            );
        }
    });

    it("rejects the same tokens on either surface", () => {
        for (const token of Object.keys(UNIMPLEMENTED_TOKENS)) {
            expect(resolveScope([labelForToken(token)]).status).toBe(
                "rejected",
            );
            expect(resolveCommand(`/autofix ${token}`).status).toBe("rejected");
        }
    });

    it("derives the label tables from the token tables", () => {
        expect(Object.keys(SCOPE_LABELS)).toEqual(
            Object.keys(SCOPE_TOKENS).map(labelForToken),
        );
        expect(Object.keys(UNIMPLEMENTED_LABELS)).toEqual(
            Object.keys(UNIMPLEMENTED_TOKENS).map(labelForToken),
        );
    });
});
