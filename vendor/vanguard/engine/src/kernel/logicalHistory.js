export function logicalRunEvents(events) {
    const restoreIndex = findLatestRestore(events);
    if (restoreIndex < 0)
        return events;
    const restore = events[restoreIndex];
    const data = objectValue(restore.data);
    const checkpointId = stringValue(data?.checkpointId);
    const checkpointJournalHash = stringValue(data?.checkpointJournalHash);
    const checkpointRootHash = stringValue(data?.checkpointRootHash);
    const checkpointJournalSequence = safeSequence(data?.checkpointJournalSequence);
    if (checkpointId === undefined || checkpointJournalHash === undefined
        || checkpointRootHash === undefined || checkpointJournalSequence === undefined) {
        throw new Error("Restored session lacks a bound checkpoint journal branch point; resume is unsafe.");
    }
    if (checkpointJournalSequence >= restore.sequence) {
        throw new Error("Restored session checkpoint sequence is not earlier than its restore event.");
    }
    const marker = events.find((event) => {
        if (event.type !== "session.checkpointed")
            return false;
        const markerData = objectValue(event.data);
        return markerData?.checkpointId === checkpointId
            && markerData?.journalHash === checkpointJournalHash
            && markerData?.rootHash === checkpointRootHash
            && markerData?.journalSequence === checkpointJournalSequence;
    });
    if (marker === undefined) {
        throw new Error("Restored session checkpoint branch point does not match its journal marker.");
    }
    const prefix = events.filter((event) => event.sequence <= checkpointJournalSequence);
    const suffix = events.slice(restoreIndex);
    return [...logicalRunEvents(prefix), ...suffix];
}
function findLatestRestore(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === "session.restored")
            return index;
    }
    return -1;
}
function objectValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function safeSequence(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
