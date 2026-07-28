import { normalizeDecision } from "./contracts.js";
import { summarizeHistoricalToolExchange } from "./historySummary.js";
import { ContextBudgetExceededError } from "./stickyContext.js";
export class EvidenceContextPolicy {
    select(task, transcript, maxBytes, reservedTail = []) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) {
            throw new Error("Context byte budget must be an integer of at least two bytes.");
        }
        const anchoredTranscript = transcript.some((entry) => entry.role === "task")
            || task.length === 0
            ? transcript
            : [{ role: "task", content: task }, ...transcript];
        if (serializedBytes([...anchoredTranscript, ...reservedTail]) <= maxBytes)
            return anchoredTranscript;
        const rawChunks = causalChunks(anchoredTranscript);
        const recentToolChunks = new Set(rawChunks.map((chunk, index) => chunk.toolExchange ? index : -1).filter((index) => index >= 0).slice(-2));
        const chunks = rawChunks.map((chunk, index) => chunk.toolExchange && !recentToolChunks.has(index) ? compactToolExchange(chunk) : chunk);
        const taskIndices = chunks
            .map((chunk, index) => chunk.entries.some((entry) => entry.role === "task") ? index : -1)
            .filter((index) => index >= 0);
        const newestUserIndex = findLastIndex(chunks, (chunk) => chunk.entries.some((entry) => entry.role === "user"));
        const newestDecisionIndex = findLastIndex(chunks, (chunk) => chunk.entries.some((entry) => entry.role === "decision"));
        const freshToolIndex = newestDecisionIndex >= 0
            && isToolDecision(chunks[newestDecisionIndex].entries[0])
            ? newestDecisionIndex
            : -1;
        const delegatedOverflowIndex = findLastIndex(chunks, (chunk) => chunk.entries.some(isDelegatedOverflowDigest));
        const requiredIndices = new Set(taskIndices);
        if (newestUserIndex >= 0)
            requiredIndices.add(newestUserIndex);
        if (freshToolIndex >= 0)
            requiredIndices.add(freshToolIndex);
        if (delegatedOverflowIndex >= 0)
            requiredIndices.add(delegatedOverflowIndex);
        const requiredEntries = [...requiredIndices]
            .sort((left, right) => left - right)
            .flatMap((index) => chunks[index].entries);
        const requiredBytes = serializedBytes([...requiredEntries, ...reservedTail]);
        if (requiredBytes > maxBytes) {
            throw new ContextBudgetExceededError(requiredBytes, maxBytes);
        }
        const selected = new Set(requiredIndices);
        let selectedEntryCount = requiredEntries.length + reservedTail.length;
        let used = requiredBytes;
        const trySelect = (index) => {
            if (selected.has(index))
                return;
            const chunk = chunks[index];
            if (chunk === undefined)
                return;
            const innerBytes = Buffer.byteLength(JSON.stringify(chunk.entries).slice(1, -1));
            const separatorBytes = selectedEntryCount === 0 ? 0 : 1;
            if (used + innerBytes + separatorBytes > maxBytes)
                return;
            selected.add(index);
            selectedEntryCount += chunk.entries.length;
            used += innerBytes + separatorBytes;
        };
        [...chunks.keys()]
            .sort((left, right) => chunks[right].priority - chunks[left].priority || right - left)
            .forEach(trySelect);
        return [...selected]
            .sort((left, right) => left - right)
            .flatMap((index) => [...chunks[index].entries]);
    }
}
function causalChunks(transcript) {
    const chunks = [];
    for (let index = 0; index < transcript.length; index += 1) {
        const entry = transcript[index];
        if (isToolDecision(entry)) {
            const entries = [entry];
            while (transcript[index + 1]?.role === "observation") {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            chunks.push({ entries, priority: 2, toolExchange: entries.length > 1 });
            continue;
        }
        const decision = entry.role === "decision" ? normalizeDecision(entry.content) : undefined;
        if (decision?.kind === "ask_user") {
            const entries = [entry];
            if (isControlObservation(transcript[index + 1], "ask_user")) {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            else if (transcript[index + 1]?.role === "user") {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
            continue;
        }
        if (decision?.kind === "execute") {
            const entries = [entry];
            if (isControlObservation(transcript[index + 1], "execute_task")) {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
            continue;
        }
        if (decision?.kind === "complete") {
            const entries = [entry];
            if (isControlObservation(transcript[index + 1], "complete_task")) {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            while (transcript[index + 1]?.role === "verification") {
                entries.push(transcript[index + 1]);
                index += 1;
            }
            chunks.push({ entries, priority: entries.length > 1 ? 3 : 1, toolExchange: false });
            continue;
        }
        if (entry.role === "observation")
            continue;
        const priority = entry.role === "verification" || entry.role === "user" || entry.role === "task"
            ? 3
            : entry.role === "history" || entry.role === "runtime" ? 2 : 1;
        chunks.push({ entries: [entry], priority, toolExchange: false });
    }
    return chunks;
}
function compactToolExchange(chunk) {
    return {
        priority: chunk.priority,
        toolExchange: false,
        entries: [summarizeHistoricalToolExchange(chunk.entries)],
    };
}
function serializedBytes(entries) {
    return Buffer.byteLength(JSON.stringify(entries));
}
function findLastIndex(values, predicate) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        if (predicate(values[index]))
            return index;
    }
    return -1;
}
function isToolDecision(entry) {
    return entry.role === "decision"
        && entry.content !== null
        && !Array.isArray(entry.content)
        && typeof entry.content === "object"
        && (entry.content.kind === "tool" || entry.content.kind === "tools");
}
function isControlObservation(entry, tool) {
    if (entry?.role !== "observation" || entry.content === null || Array.isArray(entry.content)
        || typeof entry.content !== "object")
        return false;
    return entry.content.tool === tool;
}
function isDelegatedOverflowDigest(entry) {
    return entry.role === "history"
        && typeof entry.content === "string"
        && entry.content.startsWith("[Vanguard delegated overflow digest]");
}
