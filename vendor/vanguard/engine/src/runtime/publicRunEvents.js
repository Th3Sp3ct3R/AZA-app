import { normalizeDecision } from "../kernel/contracts.js";
import { normalizeUsage } from "../inference/usageLedger.js";
export const PUBLIC_EVENT_PREFIX = "@@VANGUARD_EVENT@@";
export class PublicRunEventPresenter {
    #modelTurns = 0;
    #pendingTools = new Map();
    #pendingOrder = [];
    #lastMessage = "";
    present(event) {
        const agentId = agentIdFrom(event.data);
        if (event.type === "model.decided") {
            this.#modelTurns += 1;
            this.#pendingTools.clear();
            this.#pendingOrder = [];
            const decision = normalizeDecision(event.data);
            const data = objectValue(event.data);
            const presented = [];
            const message = decision === undefined ? undefined : decisionMessage(decision, data);
            if (message !== undefined && message !== this.#lastMessage) {
                this.#lastMessage = message;
                presented.push({
                    type: "agent.message",
                    agentId,
                    sequence: event.sequence,
                    turn: this.#modelTurns,
                    status: "info",
                    title: "Agent",
                    message,
                });
            }
            if (decision?.kind === "tools") {
                for (const call of decision.calls) {
                    const detail = toolDetail(call.name, call.input);
                    this.#pendingTools.set(call.id, { name: call.name, ...(detail === undefined ? {} : { detail }) });
                    this.#pendingOrder.push(call.id);
                    presented.push({
                        type: "tool.started",
                        agentId,
                        sequence: event.sequence,
                        turn: this.#modelTurns,
                        status: "pending",
                        title: call.name,
                        tool: call.name,
                        ...(detail === undefined ? {} : { detail }),
                    });
                }
            }
            else if (decision?.kind === "complete") {
                presented.push({
                    type: "completion.claimed",
                    agentId,
                    sequence: event.sequence,
                    turn: this.#modelTurns,
                    status: "pending",
                    title: "Completion claimed",
                    detail: "Independent verification is running",
                });
            }
            return presented;
        }
        if (event.type === "tool.completed" || event.type === "tool.failed") {
            const data = objectValue(event.data);
            const ok = event.type === "tool.completed" && data.ok !== false;
            const callId = stringValue(data.callId);
            const pendingKey = callId !== undefined && this.#pendingTools.has(callId) ? callId : this.#pendingOrder[0];
            const pending = pendingKey === undefined ? undefined : this.#pendingTools.get(pendingKey);
            if (pendingKey !== undefined) {
                this.#pendingTools.delete(pendingKey);
                this.#pendingOrder = this.#pendingOrder.filter((id) => id !== pendingKey);
            }
            const tool = stringValue(data.tool) ?? pending?.name ?? "tool";
            const detail = resultDetail(data, pending?.detail);
            const durationMs = typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
                ? Math.max(0, Math.round(data.durationMs))
                : undefined;
            return [{
                    type: event.type === "tool.completed" ? "tool.completed" : "tool.failed",
                    agentId,
                    sequence: event.sequence,
                    status: ok ? "passed" : "failed",
                    title: tool,
                    tool,
                    ...(detail === undefined ? {} : { detail }),
                    ...(durationMs === undefined ? {} : { durationMs }),
                }];
        }
        if (event.type === "run.contracted") {
            const data = objectValue(event.data);
            const contract = objectValue(data.contract);
            const objective = boundedText(stringValue(contract.objective), 220);
            return [{
                    type: "run.contracted",
                    agentId,
                    sequence: event.sequence,
                    status: "info",
                    title: "Task contract accepted",
                    ...(objective === undefined ? {} : { detail: objective }),
                }];
        }
        if (event.type === "run.waiting_for_user") {
            const data = objectValue(event.data);
            const question = boundedText(stringValue(data.question));
            return [{
                    type: "run.waiting_for_user",
                    agentId,
                    sequence: event.sequence,
                    status: "info",
                    title: "Waiting for your answer",
                    ...(question === undefined ? {} : { message: question }),
                }];
        }
        if (event.type === "verification.completed") {
            const data = objectValue(event.data);
            const passed = data.passed === true;
            const verifier = typeof data.verifier === "string" ? data.verifier : "verifier";
            return [{
                    type: "verification.completed",
                    agentId,
                    sequence: event.sequence,
                    status: passed ? "passed" : "failed",
                    title: verifier,
                    detail: passed ? "passed" : "failed",
                }];
        }
        if (event.type === "context.compacted") {
            const data = objectValue(event.data);
            const full = typeof data.fullBytes === "number" ? data.fullBytes : undefined;
            const selected = typeof data.selectedBytes === "number" ? data.selectedBytes : undefined;
            const requestProjection = data.operation === "request_projection"
                && data.durableHistoryChanged === false;
            return [{
                    type: "context.compacted",
                    agentId,
                    sequence: event.sequence,
                    status: "info",
                    title: requestProjection ? "Context projected" : "Context compacted",
                    ...(full === undefined || selected === undefined ? {} : { detail: `${formatBytes(full)} → ${formatBytes(selected)}` }),
                }];
        }
        if (event.type === "recovery.delayed") {
            const data = objectValue(event.data);
            const delayMs = typeof data.delayMs === "number" ? data.delayMs : undefined;
            const code = stringValue(data.failureCode) ?? "transient failure";
            return [{
                    type: "recovery.scheduled",
                    agentId,
                    sequence: event.sequence,
                    status: "info",
                    title: "Safe retry scheduled",
                    detail: delayMs === undefined ? code : `${code} · ${delayMs} ms backoff`,
                }];
        }
        if (event.type === "recovery.exhausted") {
            const data = objectValue(event.data);
            return [{
                    type: "recovery.exhausted",
                    agentId,
                    sequence: event.sequence,
                    status: "failed",
                    title: "Recovery budget exhausted",
                    detail: stringValue(data.reason) ?? "No safe retry remains",
                }];
        }
        if (event.type === "recovery.replan_required") {
            return [{
                    type: "recovery.replan_required",
                    agentId,
                    sequence: event.sequence,
                    status: "info",
                    title: "Replan required",
                    detail: "Repeated deterministic failure; identical replay is blocked by the circuit breaker",
                }];
        }
        if (event.type === "run.failed") {
            const data = objectValue(event.data);
            return [{
                    type: "run.failed",
                    agentId,
                    sequence: event.sequence,
                    status: "failed",
                    title: "Run stopped",
                    detail: stringValue(data.reason) ?? stringValue(data.error) ?? "Run failed",
                }];
        }
        if (event.type === "run.completed") {
            return [{
                    type: "run.completed",
                    agentId,
                    sequence: event.sequence,
                    status: "passed",
                    title: "Run completed",
                }];
        }
        return [];
    }
}
export function encodePublicRunEvent(event) {
    return `${PUBLIC_EVENT_PREFIX}${JSON.stringify(event)}\n`;
}
export function createStreamLifecyclePresenter(emit, markActivity = () => { }, coalesceMs = 150) {
    let buffer = "";
    let timer;
    let thinkingBuffer = "";
    let thinkingTimer;
    const send = (type, extra = {}) => {
        emit({ type, agentId: "main", status: "info", title: "Agent", ...extra });
    };
    const clearTimer = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = undefined;
    };
    const flush = () => {
        clearTimer();
        if (buffer.length === 0)
            return;
        const text = buffer;
        buffer = "";
        send("agent.delta", { message: text });
    };
    const clearThinkingTimer = () => {
        if (thinkingTimer !== undefined)
            clearTimeout(thinkingTimer);
        thinkingTimer = undefined;
    };
    const flushThinking = () => {
        clearThinkingTimer();
        if (thinkingBuffer.length === 0)
            return;
        const text = thinkingBuffer;
        thinkingBuffer = "";
        send("agent.thinking", { message: text });
    };
    const discard = () => {
        clearTimer();
        buffer = "";
        clearThinkingTimer();
        thinkingBuffer = "";
    };
    return {
        started(attempt) {
            markActivity();
            send("agent.stream_started", { detail: `attempt ${attempt}` });
        },
        delta(text) {
            markActivity();
            buffer += text;
            if (buffer.length >= 400) {
                flush();
                return;
            }
            if (timer === undefined) {
                timer = setTimeout(flush, coalesceMs);
                timer.unref?.();
            }
        },
        thinking(text) {
            markActivity();
            thinkingBuffer += text;
            if (thinkingBuffer.length >= 400) {
                flushThinking();
                return;
            }
            if (thinkingTimer === undefined) {
                thinkingTimer = setTimeout(flushThinking, coalesceMs);
                thinkingTimer.unref?.();
            }
        },
        reset() {
            discard();
            send("agent.stream_reset");
        },
        committed() {
            clearThinkingTimer();
            thinkingBuffer = "";
            flush();
            send("agent.stream_committed");
        },
        failed(reason) {
            discard();
            send("agent.stream_failed", { detail: reason.slice(0, 220) });
        },
        usage(value) {
            const normalized = normalizeUsage(value);
            if (normalized === undefined || normalized.inputTokens <= 0)
                return;
            send("agent.usage", { detail: String(normalized.inputTokens) });
        },
    };
}
function decisionMessage(decision, data) {
    if (decision.kind === "respond")
        return boundedText(decision.message);
    if (decision.kind === "ask_user")
        return boundedText(decision.question);
    if (decision.kind === "execute")
        return boundedText(`Starting: ${decision.contract.objective}`);
    if (decision.kind === "complete")
        return boundedText(decision.answer);
    const continuation = data.continuation;
    const record = objectValue(continuation);
    return boundedText(contentText(record.content) ?? contentText(continuation));
}
function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return undefined;
    const text = content.flatMap((item) => {
        const block = objectValue(item);
        if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string") {
            return [block.text];
        }
        if (block.type === "message" && Array.isArray(block.content)) {
            const nested = contentText(block.content);
            return nested === undefined ? [] : [nested];
        }
        return [];
    }).join("\n");
    return text.length === 0 ? undefined : text;
}
function toolDetail(name, input) {
    const fields = objectValue(input);
    const path = stringValue(fields.path);
    if (path !== undefined)
        return path;
    if (name === "run_command") {
        const command = stringValue(fields.command) ?? "process";
        const args = Array.isArray(fields.args) ? fields.args.filter((item) => typeof item === "string") : [];
        return boundedText([command, ...args].join(" "), 180);
    }
    if (name === "check_project")
        return "trusted project verification";
    if (name === "run.checkpoint")
        return "durable working state";
    if (name === "update_plan")
        return "engineering plan revision";
    return undefined;
}
function resultDetail(data, priorDetail) {
    const output = objectValue(data.output);
    const error = stringValue(data.error) ?? stringValue(output.error);
    if (error !== undefined)
        return boundedText(error, 220);
    const exitCode = typeof output.exitCode === "number" ? output.exitCode : undefined;
    if (exitCode !== undefined) {
        const stderr = data.ok === false ? stringValue(output.stderr)?.replace(/\s+/gu, " ").trim() : undefined;
        if (stderr !== undefined && stderr.length > 0) {
            return boundedText(`exit ${exitCode} · ${stderr.slice(-160)}`, 240);
        }
        return `exit ${exitCode}`;
    }
    const path = stringValue(output.path);
    if (path !== undefined) {
        const replacements = typeof output.replacements === "number" ? ` · ${output.replacements} replacement(s)` : "";
        return `${path}${replacements}`;
    }
    if (typeof output.changedFiles === "number")
        return `${output.changedFiles} changed file(s)`;
    return priorDetail;
}
function agentIdFrom(data) {
    const value = objectValue(data).agentId;
    return typeof value === "string" && value.length > 0 ? value : "main";
}
function objectValue(value) {
    return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function boundedText(value, max = 900) {
    if (value === undefined)
        return undefined;
    const compact = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (compact.length === 0)
        return undefined;
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
function formatBytes(bytes) {
    if (bytes < 1_000)
        return `${bytes} B`;
    if (bytes < 1_000_000)
        return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
