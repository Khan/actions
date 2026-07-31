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
