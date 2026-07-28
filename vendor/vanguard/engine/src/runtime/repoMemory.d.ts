import type { JsonValue, ToolContext, ToolDefinition, ToolPort, ToolResult } from "../kernel/contracts.js";
/**
 * Durable per-repository memory with active forgetting.
 *
 * Facts an agent re-derives every session — which build command actually
 * works, which test is flaky, what convention the maintainer enforces — are
 * pure waste to relearn and pure noise to hoard. This store keeps a small,
 * scored set per workspace (`.vanguard/memory.json`, outside fingerprints
 * and reviews): the model records facts deliberately, confirmations raise a
 * fact's standing, refutations sink it, and the cap plus age decay evict the
 * losers. Injection is a dagger, not an archive: only the top few facts ever
 * reach the prompt.
 */
export type MemoryKind = "command" | "convention" | "gotcha" | "fact";
export interface MemoryEntry {
    readonly id: string;
    readonly kind: MemoryKind;
    readonly fact: string;
    readonly createdAt: number;
    readonly lastTouchedAt: number;
    readonly confirmations: number;
    readonly refutations: number;
}
export declare class RepoMemoryStore {
    #private;
    private readonly now;
    constructor(workspaceRoot: string, now?: () => number);
    entries(): Promise<readonly MemoryEntry[]>;
    score(entry: MemoryEntry): number;
    remember(kind: MemoryKind, fact: string): Promise<MemoryEntry>;
    confirm(id: string): Promise<MemoryEntry>;
    refute(id: string): Promise<MemoryEntry>;
    forget(id: string): Promise<boolean>;
    /** The dagger: at most a handful of the strongest facts, or empty text. */
    addendum(): Promise<string>;
}
export declare class RepoMemoryTool implements ToolPort {
    private readonly store;
    readonly name = "memory_note";
    readonly definition: ToolDefinition;
    constructor(store: RepoMemoryStore);
    execute(input: JsonValue, _context: ToolContext): Promise<ToolResult>;
}
