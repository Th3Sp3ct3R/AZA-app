import { MemoryJournal } from "../kernel/memoryJournal.js";
import { AgentKernel } from "../kernel/run.js";
const DEFAULT_SCOUT_STEPS = 12;
const MAX_SCOUT_STEPS = 24;
const MAX_OBJECTIVE_LENGTH = 4_000;
const SCOUT_CONTEXT_BYTES = 400_000;
export class ScoutDelegateTool {
    name = "delegate_scout";
    definition = {
        name: this.name,
        description: "Send a bounded read-only subagent to investigate the workspace and return a dense digest (findings, exact paths, line references). Use it for broad reconnaissance that would otherwise flood your context with raw file contents; ask one precise objective per scout.",
        inputSchema: {
            type: "object",
            properties: {
                objective: { type: "string", description: "One precise investigation objective, e.g. 'map every caller of the retry helper and note how each handles failure'." },
                maxSteps: { type: "integer", minimum: 4, maximum: MAX_SCOUT_STEPS, description: `Step budget for the scout; defaults to ${DEFAULT_SCOUT_STEPS}.` },
            },
            required: ["objective"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    #model;
    #tools;
    constructor(model, tools) {
        this.#model = model;
        this.#tools = tools.filter((tool) => tool.definition.effect === "observe" && tool.name !== this.name);
    }
    async execute(input, context) {
        if (input === null || Array.isArray(input) || typeof input !== "object") {
            throw new Error("Scout input must be an object.");
        }
        const objective = input.objective;
        if (typeof objective !== "string" || objective.trim().length === 0 || objective.length > MAX_OBJECTIVE_LENGTH) {
            throw new Error(`Scout 'objective' must be a non-empty string of at most ${MAX_OBJECTIVE_LENGTH} characters.`);
        }
        const maxSteps = input.maxSteps ?? DEFAULT_SCOUT_STEPS;
        if (typeof maxSteps !== "number" || !Number.isSafeInteger(maxSteps) || maxSteps < 4 || maxSteps > MAX_SCOUT_STEPS) {
            throw new Error(`Scout 'maxSteps' must be an integer from 4 through ${MAX_SCOUT_STEPS}.`);
        }
        const journal = new MemoryJournal();
        const kernel = new AgentKernel({
            model: this.#model,
            tools: this.#tools,
            verifiers: [],
            journal,
            options: {
                maxSteps,
                maxContextBytes: SCOUT_CONTEXT_BYTES,
                interactive: false,
            },
        });
        const task = `You are a reconnaissance scout: a read-only subagent inside a larger engineering run.\n`
            + `Objective: ${objective.trim()}\n`
            + "Investigate with the provided read-only tools, then call complete_task whose summary is the digest itself: "
            + "concrete findings with exact workspace-relative paths and line references, direct answers to the objective, "
            + "and explicit 'not found' statements where the evidence is absent. Never speculate beyond what you observed. "
            + "You cannot modify anything; do not try.";
        const outcome = await kernel.run(task, context.signal);
        const steps = outcome.steps;
        if (outcome.status === "completed") {
            return { ok: true, output: { objective: objective.trim(), digest: outcome.answer, steps } };
        }
        const reason = outcome.status === "failed"
            ? outcome.reason
            : `Scout yielded '${outcome.status}' instead of a digest.`;
        return {
            ok: false,
            output: {
                error: `Scout did not complete its reconnaissance: ${reason} Narrow the objective or raise maxSteps (max ${MAX_SCOUT_STEPS}).`,
                objective: objective.trim(),
                steps,
            },
        };
    }
}
