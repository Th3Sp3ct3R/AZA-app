export type OllamaModelSource = "local" | "cloud" | "cloud-catalog";
export interface OllamaModelChoice {
    readonly id: string;
    readonly note: string;
    readonly source: OllamaModelSource;
    /** OpenAI-compatible chat endpoint to bind onto the Vanguard session. */
    readonly endpoint: string;
    /** False means the local daemon must pull the tiny Cloud model stub first. */
    readonly ready: boolean;
}
export interface OllamaDiscovery {
    readonly models: readonly OllamaModelChoice[];
    readonly localAvailable: boolean;
    readonly cloudApiAvailable: boolean;
    readonly publicCatalogAvailable: boolean;
    readonly localBaseUrl: string;
}
interface DiscoverOptions {
    readonly fetchImpl?: typeof fetch;
    readonly environment?: NodeJS.ProcessEnv;
    /** Tests and offline embedders can skip the public library crawl. */
    readonly includePublicCatalog?: boolean;
    readonly timeoutMs?: number;
}
export declare function discoverOllamaModels(options?: DiscoverOptions): Promise<OllamaDiscovery>;
/** Pull a not-yet-installed Cloud stub through the signed-in local daemon. */
export declare function prepareOllamaModel(model: OllamaModelChoice, options: Pick<DiscoverOptions, "fetchImpl" | "timeoutMs"> & {
    readonly localBaseUrl: string;
}): Promise<void>;
export {};
