export function createDelegationTools(coordinator) {
    return [
        new DelegateAgentTool(coordinator),
        new DelegateSwarmTool(coordinator),
        new DelegateStartTool(coordinator),
        new DelegateStatusTool(coordinator),
        new DelegateWaitTool(coordinator),
        new DelegateCancelTool(coordinator),
        new DelegateMergeTool(coordinator),
        new DelegateRaceTool(coordinator),
    ];
}
export class DelegateAgentTool {
    coordinator;
    name = "delegate_agent";
    definition = {
        name: this.name,
        description: "Launch one isolated subagent. coder can produce a reviewed patch; explore and plan are runtime-enforced read-only. Background mode returns immediately; foreground returns the final child record or a still-running record at the bounded timeout.",
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string", description: "Self-contained objective and expected handoff." },
                description: { type: "string", description: "Short 3-5 word label." },
                subagentType: { type: "string", enum: ["coder", "explore", "plan"], description: "Capability profile; defaults to coder." },
                scopes: { type: "array", items: { type: "string" }, description: "Workspace-relative roots. For coder these are the only editable roots." },
                maxSteps: { type: "integer", minimum: 1, description: "Child turn budget; defaults to 24." },
                runInBackground: { type: "boolean", description: "Return immediately after queueing; defaults to false." },
                timeoutMs: { type: "integer", minimum: 1, maximum: 600000, description: "Foreground wait bound; defaults to 120000." },
            },
            required: ["prompt", "description", "scopes"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const prompt = stringField(fields, "prompt");
        const description = stringField(fields, "description");
        const profile = profileField(fields.subagentType);
        const scopes = stringArray(fields.scopes, "scopes");
        const maxSteps = fields.maxSteps === undefined ? 24 : integerField(fields, "maxSteps");
        const background = booleanField(fields, "runInBackground", false);
        const timeoutMs = fields.timeoutMs === undefined ? 120_000 : integerField(fields, "timeoutMs");
        if (timeoutMs > 600_000)
            throw new Error("delegate_agent timeoutMs may not exceed 600000.");
        const record = await this.coordinator.start({
            task: profilePrompt(profile, description, prompt),
            scopes,
            maxSteps,
            profile,
        });
        return ok(background ? record : await this.coordinator.wait(record.id, timeoutMs));
    }
}
export class DelegateSwarmTool {
    coordinator;
    name = "delegate_swarm";
    definition = {
        name: this.name,
        description: "Fan one prompt template out to distinct isolated subagents. Use {{item}} in promptTemplate. Results are aggregated; coder patches remain candidates and each requires an explicit delegate_merge.",
        inputSchema: {
            type: "object",
            properties: {
                description: { type: "string", description: "Short label for the whole swarm." },
                promptTemplate: { type: "string", description: "Per-child prompt containing {{item}}." },
                items: { type: "array", items: { type: "string" }, description: "2-6 distinct values substituted into {{item}}; Vanguard's default durable child cap is six." },
                subagentType: { type: "string", enum: ["coder", "explore", "plan"], description: "Capability profile for every child; defaults to coder." },
                scopes: { type: "array", items: { type: "string" }, description: "Workspace-relative roots inherited by every child." },
                maxSteps: { type: "integer", minimum: 1, description: "Step budget per child; defaults to 24." },
                runInBackground: { type: "boolean", description: "Return all queued ids immediately; defaults to false." },
                timeoutMs: { type: "integer", minimum: 1, maximum: 600000, description: "Total foreground wait bound; defaults to 120000." },
            },
            required: ["description", "promptTemplate", "items", "scopes"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const description = stringField(fields, "description");
        const template = stringField(fields, "promptTemplate");
        if (!template.includes("{{item}}"))
            throw new Error("delegate_swarm promptTemplate must contain {{item}}.");
        const items = stringArray(fields.items, "items");
        if (items.length < 2 || items.length > 6)
            throw new Error("delegate_swarm requires 2 through 6 items.");
        const prompts = items.map((item) => template.split("{{item}}").join(item));
        if (new Set(prompts).size !== prompts.length)
            throw new Error("delegate_swarm items produced duplicate prompts.");
        const profile = profileField(fields.subagentType);
        const scopes = stringArray(fields.scopes, "scopes");
        const maxSteps = fields.maxSteps === undefined ? 24 : integerField(fields, "maxSteps");
        const background = booleanField(fields, "runInBackground", false);
        const timeoutMs = fields.timeoutMs === undefined ? 120_000 : integerField(fields, "timeoutMs");
        if (timeoutMs > 600_000)
            throw new Error("delegate_swarm timeoutMs may not exceed 600000.");
        const records = [];
        for (let index = 0; index < prompts.length; index += 1) {
            records.push(await this.coordinator.start({
                task: profilePrompt(profile, `${description} #${index + 1}`, prompts[index]),
                scopes,
                maxSteps,
                profile,
            }));
        }
        if (background)
            return jsonOk({ background: true, agents: records });
        const settled = await Promise.all(records.map((record) => this.coordinator.wait(record.id, timeoutMs)));
        return jsonOk({
            summary: {
                completed: settled.filter((record) => record.state === "completed").length,
                failed: settled.filter((record) => record.state === "failed").length,
                running: settled.filter((record) => record.state === "running" || record.state === "queued").length,
            },
            agents: settled,
        });
    }
}
function profilePrompt(profile, description, prompt) {
    const role = profile === "coder"
        ? "Implement the scoped objective, verify it, and return a concise technical handoff."
        : profile === "explore"
            ? "Investigate only. Return concrete findings with exact paths and evidence; do not edit files."
            : "Produce an implementation plan and architecture analysis only; do not edit files.";
    return `Subagent profile: ${profile}. Label: ${description.trim()}.\n${role}\n\n${prompt.trim()}`;
}
function profileField(value) {
    if (value === undefined)
        return "coder";
    if (value === "coder" || value === "explore" || value === "plan")
        return value;
    throw new Error("subagentType must be coder, explore, or plan.");
}
function booleanField(fields, name, fallback) {
    const value = fields[name];
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean")
        throw new Error(`Field '${name}' must be boolean.`);
    return value;
}
function jsonOk(value) {
    return { ok: true, output: JSON.parse(JSON.stringify(value)) };
}
export class DelegateRaceTool {
    coordinator;
    name = "delegate_race";
    definition = {
        name: this.name,
        description: "Race 2-3 competing fix hypotheses as isolated children; the first to complete wins and the rest are cancelled. Use after sequential attempts at the same failure have not landed. Each variant must be a self-contained task describing a DIFFERENT approach. The winner's patch still needs delegate_merge.",
        inputSchema: {
            type: "object",
            properties: {
                variants: {
                    type: "array",
                    items: { type: "string" },
                    description: "Competing self-contained task briefs, one per hypothesis; exactly 2 or 3.",
                },
                scopes: { type: "array", items: { type: "string" }, description: "Workspace-relative roots each child may edit." },
                maxSteps: { type: "integer", minimum: 1, description: "Step budget per child." },
                timeoutMs: { type: "integer", minimum: 10_000, maximum: 1_800_000, description: "Overall race budget; defaults to 600000." },
            },
            required: ["variants", "scopes", "maxSteps"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const variants = stringArray(fields.variants, "variants");
        if (variants.length < 2 || variants.length > 3) {
            throw new Error("delegate_race requires 2 or 3 variants.");
        }
        const scopes = stringArray(fields.scopes, "scopes");
        const maxSteps = integerField(fields, "maxSteps");
        const timeoutMs = fields.timeoutMs === undefined ? 600_000 : integerField(fields, "timeoutMs");
        const deadline = Date.now() + Math.min(1_800_000, Math.max(10_000, timeoutMs));
        const racers = [];
        for (const variant of variants) {
            racers.push(await this.coordinator.start({ task: variant, scopes, maxSteps }));
        }
        const ids = racers.map((racer) => racer.id);
        let winner;
        const settled = new Map();
        while (winner === undefined && settled.size < ids.length && Date.now() < deadline) {
            for (const id of ids) {
                if (settled.has(id))
                    continue;
                const record = await this.coordinator.wait(id, 1_000);
                if (record.state === "completed") {
                    winner = record;
                    break;
                }
                if (record.state === "failed" || record.state === "cancelled" || record.state === "interrupted") {
                    settled.set(id, record);
                }
            }
        }
        for (const id of ids) {
            if (id === winner?.id)
                continue;
            try {
                await this.coordinator.cancel(id);
            }
            catch {
            }
        }
        if (winner !== undefined) {
            return {
                ok: true,
                output: {
                    winner: winner.id,
                    answer: winner.answer ?? null,
                    review: (winner.review ?? null),
                    cancelled: ids.filter((id) => id !== winner.id),
                    note: "Merge the winner with delegate_merge using its review confirmation; losers were cancelled and must not be merged.",
                },
            };
        }
        return {
            ok: false,
            output: {
                error: settled.size === ids.length
                    ? "Every hypothesis failed; inspect the failures and form a genuinely different approach before racing again."
                    : "The race hit its time budget with no completed child; the remaining children were cancelled.",
                results: ids.map((id) => {
                    const record = this.coordinator.get(id);
                    return { id, state: record.state, ...(record.answer === undefined ? {} : { answer: record.answer.slice(0, 400) }) };
                }),
            },
        };
    }
}
export class DelegateStartTool {
    coordinator;
    name = "delegate_start";
    definition = {
        name: this.name,
        description: "Start a real isolated Vanguard child for a scoped coding subtask. Returns immediately; use delegate_status or delegate_wait to observe it.",
        inputSchema: {
            type: "object",
            properties: {
                task: { type: "string", description: "Self-contained child objective and acceptance criteria." },
                scopes: {
                    type: "array",
                    items: { type: "string" },
                    description: "One or more workspace-relative roots the child may edit.",
                },
                maxSteps: { type: "integer", minimum: 1, description: "Reserved child step budget." },
            },
            required: ["task", "scopes", "maxSteps"],
            additionalProperties: false,
        },
        effect: "state",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const task = stringField(fields, "task");
        const maxSteps = integerField(fields, "maxSteps");
        const scopes = stringArray(fields.scopes, "scopes");
        return ok(await this.coordinator.start({ task, scopes, maxSteps }));
    }
}
export class DelegateStatusTool {
    coordinator;
    name = "delegate_status";
    definition = {
        name: this.name,
        description: "Read one isolated child's durable status, answer, step count, and reviewed patch summary.",
        inputSchema: idSchema(),
        effect: "observe",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        return ok(this.coordinator.get(stringField(objectInput(input), "id")));
    }
}
export class DelegateWaitTool {
    coordinator;
    name = "delegate_wait";
    definition = {
        name: this.name,
        description: "Wait for one child to settle, bounded by timeoutMs. A timed-out wait returns the still-running status and does not cancel it.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Child id returned by delegate_start." },
                timeoutMs: { type: "integer", minimum: 1, maximum: 120_000, description: "Bounded wait; defaults to 30000." },
            },
            required: ["id"],
            additionalProperties: false,
        },
        effect: "observe",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        const timeoutMs = fields.timeoutMs === undefined ? 30_000 : integerField(fields, "timeoutMs");
        if (timeoutMs > 120_000)
            throw new Error("delegate_wait timeoutMs may not exceed 120000.");
        return ok(await this.coordinator.wait(stringField(fields, "id"), timeoutMs));
    }
}
export class DelegateCancelTool {
    coordinator;
    name = "delegate_cancel";
    definition = {
        name: this.name,
        description: "Cancel a queued or running child. Cancellation never applies its candidate patch.",
        inputSchema: idSchema(),
        effect: "state",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        return ok(await this.coordinator.cancel(stringField(objectInput(input), "id")));
    }
}
export class DelegateMergeTool {
    coordinator;
    name = "delegate_merge";
    definition = {
        name: this.name,
        description: "Transactionally apply a completed child's reviewed patch to the disposable parent workspace. manifestHash must exactly match delegate_status; drift or conflicts are refused.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Completed child id." },
                manifestHash: { type: "string", description: "Exact 64-character review manifest hash." },
            },
            required: ["id", "manifestHash"],
            additionalProperties: false,
        },
        effect: "mutate",
    };
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(input, _context) {
        const fields = objectInput(input);
        return ok(await this.coordinator.merge(stringField(fields, "id"), stringField(fields, "manifestHash")));
    }
}
function idSchema() {
    return {
        type: "object",
        properties: { id: { type: "string", description: "Child id returned by delegate_start." } },
        required: ["id"],
        additionalProperties: false,
    };
}
function objectInput(value) {
    if (value === null || Array.isArray(value) || typeof value !== "object")
        throw new Error("Tool input must be an object.");
    return value;
}
function stringField(fields, name) {
    const value = fields[name];
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`Field '${name}' must be a non-empty string.`);
    return value;
}
function integerField(fields, name) {
    const value = fields[name];
    if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1) {
        throw new Error(`Field '${name}' must be a positive integer.`);
    }
    return value;
}
function stringArray(value, name) {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
        throw new Error(`Field '${name}' must be a non-empty string array.`);
    }
    return value;
}
function ok(record) {
    return { ok: true, output: JSON.parse(JSON.stringify(record)) };
}
