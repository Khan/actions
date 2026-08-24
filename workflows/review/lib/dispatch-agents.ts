/**
 * Agent-definition loading for the scripted dispatcher: parsing the gh-aw
 * inline agents the activation job extracts to `.claude/agents/`. Split out of
 * `dispatch.ts` for its max-lines budget (the same cap that drove the roster
 * split in #304); the concern is self-contained and has no dispatch state.
 */

export type DispatchFs = {
    readFileSync: (p: string, enc: "utf8") => string;
    writeFileSync: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    mkdirSync: (p: string, opts: {recursive: boolean}) => void;
    readdirSync: (p: string) => string[];
};

export type AgentDefinition = {name: string; model: string; prompt: string};

/**
 * Parse one gh-aw inline agent file: YAML-ish frontmatter carrying `name:`
 * and `model:`, body = the prompt. Deliberately minimal — these files are
 * machine-written by gh-aw's extraction, not hand-authored.
 */
export const parseAgentFile = (text: string): AgentDefinition | null => {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (match === null) {
        return null;
    }
    const front = match[1];
    const prompt = match[2].trim();
    const field = (key: string): string | undefined => {
        const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front);
        return line?.[1]?.trim();
    };
    const name = field("name");
    if (name === undefined || prompt === "") {
        return null;
    }
    return {name, model: field("model") ?? "", prompt};
};

export const loadAgents = (
    fs: DispatchFs,
    agentsDir: string,
): Map<string, AgentDefinition> => {
    const agents = new Map<string, AgentDefinition>();
    if (!fs.existsSync(agentsDir)) {
        return agents;
    }
    for (const entry of fs.readdirSync(agentsDir)) {
        if (!entry.endsWith(".md")) {
            continue;
        }
        try {
            const parsed = parseAgentFile(
                fs.readFileSync(`${agentsDir}/${entry}`, "utf8"),
            );
            if (parsed !== null) {
                agents.set(parsed.name, parsed);
            }
        } catch {
            // An unreadable definition surfaces later as an unavailable
            // dimension for whatever roster entry needed it.
        }
    }
    return agents;
};

/** One sub-agent dispatch request (mirrors the eval's LiveAgentRequest). */
export type AgentRequest = {
    name: string;
    model: string;
    prompt: string;
    cwd: string;
    maxTurns: number;
    timeoutMs: number;
    /**
     * The structured-final contract check (trial suggestion h). When set,
     * the runner exposes a `submit_result` tool whose input is validated by
     * this function BEFORE it is accepted: null accepts the payload as the
     * agent's result; a string rejects it back to the model, which corrects
     * and re-calls in the same session (a few turns, not the $2-3 full
     * re-dispatch the malformed-output retry costs). Free-text finals stay as
     * the fallback for a model that never calls the tool.
     */
    validate?: (payload: Record<string, unknown>) => string | null;
    /**
     * The prose style gate (judge-prose.ts), awaited by the runner AFTER
     * `validate` accepts: `null` accepts the payload; a string rejects it
     * back to the authoring model exactly like a contract rejection, so the
     * AUTHOR rewrites its own prose in-session (the plain-prose loop). The
     * gate caps its own bounces and fails open; it can slow a submission,
     * never lose one.
     */
    judgeProse?: (payload: Record<string, unknown>) => Promise<string | null>;
};

export type AgentResult = {
    /** The agent's final text (expected to be its JSON contract). */
    output: string;
    usd: number;
    turns: number;
    wallMs: number;
    /**
     * Tool calls the agent made. The harness-parity signal: a loop that
     * investigates with fewer tool calls and scores lower has a toolbox
     * problem, not a model problem. Optional because a runner that cannot
     * count them reports nothing rather than a misleading zero.
     */
    toolCalls?: number;
    /**
     * The provider's stop reason for the agent's last assistant message, when
     * the runner can see one. Load-bearing for one specific diagnosis: an
     * EMPTY final on cyber-adjacent input is the signature of a refusal, which
     * #294 documents as surfacing "as a missing agent result, not an error".
     * Without this the empty result is indistinguishable from a dropped one.
     */
    stopReason?: string;
    /**
     * Why the call failed, when the runner can see it. `stopReason=error`
     * alone does not distinguish an overloaded provider from a prompt that
     * outgrew the context window, and those have opposite fixes (retries vs
     * compaction). `tokensAtFailure` is the discriminator: near the model's
     * context window means overflow.
     */
    errorMessage?: string;
    /** The provider's own stop reason, before the runner normalizes it. */
    rawStopReason?: string;
    /** Input and total tokens on the last assistant message. */
    tokensAtFailure?: {input: number; total: number};
    /**
     * The provider blocked the request under its usage policy. Distinct from
     * every other failure because it is deterministic in the model, not
     * transient: retrying the same pin returns the same refusal, so the only
     * useful response is a different model.
     */
    refused?: boolean;
    /** The output came through the structured-final tool, pre-validated. */
    structured?: boolean;
};

/** The model seam; the SDK-backed production runner lives in the CLI entry. */
export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;
