import { createHash } from "node:crypto";
import { compareOrdinal } from "../deterministicText.js";
export function durableStateSha256(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function latestDurableStateAnchor(events, tool) {
    for (const event of [...events].reverse()) {
        if (event.type !== "tool.completed" || event.data === null || Array.isArray(event.data)
            || typeof event.data !== "object" || event.data.tool !== tool || event.data.ok === false)
            continue;
        const output = event.data.output;
        if (output === null || Array.isArray(output) || typeof output !== "object")
            continue;
        const sha256 = output.stateSha256;
        if (typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256)) {
            return { tool, sequence: event.sequence, sha256 };
        }
    }
    return undefined;
}
function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value)
        .sort(([left], [right]) => compareOrdinal(left, right))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
        .join(",")}}`;
}
