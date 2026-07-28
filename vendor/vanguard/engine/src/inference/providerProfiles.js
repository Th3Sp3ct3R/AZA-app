import { readFile } from "node:fs/promises";
import { CODEX_RESPONSES_URL } from "./oauth/openaiOAuth.js";
import { KIMI_CHAT_COMPLETIONS_URL } from "./oauth/kimiOAuth.js";
export const VANGUARD_PROVIDER_CONFIG_VERSION = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000;
const PROVIDER_DEFAULTS = {
    openai: {
        endpoint: "https://api.openai.com/v1/responses",
        wire: "openai-responses",
        credentialVariable: "OPENAI_API_KEY",
    },
    anthropic: {
        endpoint: "https://api.anthropic.com/v1/messages",
        wire: "anthropic-messages",
        credentialVariable: "ANTHROPIC_API_KEY",
        apiVersion: "2023-06-01",
        maxOutputTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
    },
    deepseek: {
        endpoint: "https://api.deepseek.com/chat/completions",
        wire: "openai-chat-completions",
        credentialVariable: "DEEPSEEK_API_KEY",
    },
    kimi: {
        endpoint: KIMI_CHAT_COMPLETIONS_URL,
        wire: "openai-chat-completions",
        credentialVariable: "KIMI_API_KEY",
    },
    ollama: {
        endpoint: "http://127.0.0.1:11434/v1/chat/completions",
        wire: "openai-chat-completions",
        credentialVariable: "OLLAMA_API_KEY",
    },
};
const WIRE_CAPABILITIES = {
    "openai-responses": {
        streaming: true,
        parallelToolCalls: true,
        streamUsage: true,
        continuationReplay: true,
    },
    "openai-chat-completions": {
        streaming: true,
        parallelToolCalls: true,
        streamUsage: true,
        continuationReplay: true,
    },
    "anthropic-messages": {
        streaming: true,
        parallelToolCalls: true,
        streamUsage: true,
        continuationReplay: true,
    },
};
export function resolveProviderProfile(input, environment = process.env) {
    validateConfigShape(input);
    const defaults = input.provider === "openai-compatible" ? undefined : PROVIDER_DEFAULTS[input.provider];
    const wire = input.wire ?? defaults?.wire ?? "openai-chat-completions";
    if (defaults !== undefined && wire !== defaults.wire) {
        throw new Error(`${input.provider} profiles must use the ${defaults.wire} public wire contract.`);
    }
    if (input.provider === "openai-compatible" && wire !== "openai-chat-completions") {
        throw new Error("openai-compatible profiles currently support only the public Chat Completions wire contract.");
    }
    const credential = input.credential ?? (defaults === undefined
        ? undefined
        : { source: "environment", variable: defaults.credentialVariable });
    if (credential === undefined) {
        throw new Error("openai-compatible profiles require an explicit environment credential variable.");
    }
    validateCredential(credential, input.provider);
    const endpointDefault = credential.source === "oauth" && input.provider === "openai"
        ? CODEX_RESPONSES_URL
        : defaults?.endpoint;
    const endpoint = validateEndpoint(input.endpoint ?? endpointDefault, input.provider);
    const apiVersion = input.apiVersion ?? defaults?.apiVersion;
    if (wire === "anthropic-messages") {
        if (apiVersion === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(apiVersion)) {
            throw new Error("Anthropic Messages profiles require an apiVersion in YYYY-MM-DD form.");
        }
    }
    else if (apiVersion !== undefined) {
        throw new Error("apiVersion is valid only for the Anthropic Messages wire contract.");
    }
    const baseline = input.provider === "openai-compatible"
        ? { streaming: false, parallelToolCalls: false, streamUsage: false, continuationReplay: false }
        : input.provider === "ollama"
            ? { streaming: true, parallelToolCalls: false, streamUsage: false, continuationReplay: false }
            : WIRE_CAPABILITIES[wire];
    const streaming = input.capabilities?.streaming ?? baseline.streaming;
    const capabilities = {
        streaming,
        parallelToolCalls: input.capabilities?.parallelToolCalls ?? baseline.parallelToolCalls,
        streamUsage: streaming && (input.capabilities?.streamUsage ?? baseline.streamUsage),
        continuationReplay: input.capabilities?.continuationReplay ?? baseline.continuationReplay,
    };
    const maxOutputTokens = input.maxOutputTokens ?? defaults?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const reasoning = validateReasoning(input.reasoning, wire, maxOutputTokens, input.provider);
    return {
        version: VANGUARD_PROVIDER_CONFIG_VERSION,
        provider: input.provider,
        model: input.model.trim(),
        endpoint,
        wire,
        credential,
        credentialProvenance: credential.source === "oauth"
            ? { source: "oauth", provider: credential.provider, resolvedAtRequestTime: true }
            : {
                source: "environment",
                variable: credential.variable,
                present: typeof environment[credential.variable] === "string" && environment[credential.variable].length > 0,
            },
        capabilities,
        ...(apiVersion === undefined ? {} : { apiVersion }),
        maxOutputTokens,
        ...(reasoning === undefined ? {} : { reasoning }),
        credentialOptional: input.provider === "ollama",
    };
}
function validateReasoning(reasoning, wire, maxOutputTokens, provider) {
    if (reasoning === undefined)
        return undefined;
    if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) {
        throw new Error("Provider reasoning config must be an object.");
    }
    for (const name of Object.keys(reasoning)) {
        if (name !== "thinkingBudgetTokens" && name !== "effort" && name !== "thinking") {
            throw new Error(`Unknown provider reasoning field: ${name}.`);
        }
    }
    const budget = reasoning.thinkingBudgetTokens;
    const effort = reasoning.effort;
    const thinking = reasoning.thinking;
    if (budget !== undefined) {
        if (wire !== "anthropic-messages") {
            throw new Error("thinkingBudgetTokens is valid only for the Anthropic Messages wire contract.");
        }
        if (!Number.isSafeInteger(budget) || budget < 1_024) {
            throw new Error("thinkingBudgetTokens must be an integer of at least 1024.");
        }
        if (budget >= maxOutputTokens) {
            throw new Error("thinkingBudgetTokens must be smaller than maxOutputTokens.");
        }
    }
    if (effort !== undefined) {
        if (wire !== "openai-responses" && provider !== "kimi") {
            throw new Error("reasoning effort is valid only for the OpenAI Responses wire contract or the Kimi provider.");
        }
        if (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "max") {
            throw new Error("reasoning effort must be low, medium, high, or max.");
        }
        if (effort === "max" && provider !== "kimi")
            throw new Error("max reasoning effort is valid only for Kimi.");
    }
    if (thinking !== undefined && provider !== "kimi")
        throw new Error("thinking mode is valid only for Kimi.");
    if (thinking !== undefined && thinking !== "enabled" && thinking !== "disabled") {
        throw new Error("Kimi thinking mode must be enabled or disabled.");
    }
    if (thinking === "disabled" && effort !== undefined)
        throw new Error("Kimi reasoning effort requires thinking to be enabled.");
    if (budget === undefined && effort === undefined && thinking === undefined)
        return undefined;
    return reasoning;
}
export async function readProviderProfile(file, environment = process.env) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read provider config: ${detail}`);
    }
    return resolveProviderProfile(parsed, environment);
}
export function describeProviderProfile(profile) {
    return {
        version: profile.version,
        provider: profile.provider,
        model: profile.model,
        endpoint: profile.endpoint,
        wire: profile.wire,
        credential: profile.credentialProvenance,
        capabilities: profile.capabilities,
        ...(profile.apiVersion === undefined ? {} : { apiVersion: profile.apiVersion }),
        maxOutputTokens: profile.maxOutputTokens,
        ...(profile.reasoning === undefined ? {} : { reasoning: profile.reasoning }),
    };
}
function validateConfigShape(input) {
    if (input === null || typeof input !== "object")
        throw new Error("Provider config must be an object.");
    if (input.version !== VANGUARD_PROVIDER_CONFIG_VERSION) {
        throw new Error(`Unsupported provider config version: ${String(input.version)}.`);
    }
    if (!(input.provider === "openai" || input.provider === "anthropic" || input.provider === "deepseek"
        || input.provider === "kimi" || input.provider === "ollama" || input.provider === "openai-compatible")) {
        throw new Error(`Unsupported provider: ${String(input.provider)}.`);
    }
    if (typeof input.model !== "string" || input.model.trim().length === 0 || input.model.length > 256) {
        throw new Error("Provider model must be a non-empty string no longer than 256 characters.");
    }
    if (input.wire !== undefined && !Object.hasOwn(WIRE_CAPABILITIES, input.wire)) {
        throw new Error(`Unsupported provider wire contract: ${String(input.wire)}.`);
    }
    if (input.endpoint !== undefined && typeof input.endpoint !== "string") {
        throw new Error("Provider endpoint must be a string.");
    }
    if (input.apiVersion !== undefined && typeof input.apiVersion !== "string") {
        throw new Error("Provider apiVersion must be a string.");
    }
    if (input.maxOutputTokens !== undefined
        && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 256 || input.maxOutputTokens > 1_000_000)) {
        throw new Error("maxOutputTokens must be an integer from 256 through 1000000.");
    }
    if (input.capabilities !== undefined) {
        if (input.capabilities === null || typeof input.capabilities !== "object") {
            throw new Error("Provider capabilities must be an object.");
        }
        for (const [name, value] of Object.entries(input.capabilities)) {
            if (!(name === "streaming" || name === "parallelToolCalls" || name === "streamUsage" || name === "continuationReplay")) {
                throw new Error(`Unknown provider capability: ${name}.`);
            }
            if (typeof value !== "boolean")
                throw new Error(`Provider capability ${name} must be boolean.`);
        }
    }
}
function validateCredential(credential, provider) {
    if (credential === null || typeof credential !== "object") {
        throw new Error("Provider credential must be an object.");
    }
    if (credential.source === "oauth") {
        if (credential.provider !== "anthropic" && credential.provider !== "openai" && credential.provider !== "kimi") {
            throw new Error("OAuth credentials are available only for the anthropic and openai providers, plus kimi.");
        }
        if (credential.provider !== provider) {
            throw new Error(`An oauth credential for ${credential.provider} cannot authenticate the ${provider} provider.`);
        }
        return;
    }
    if (credential.source !== "environment") {
        throw new Error("Provider credentials must use the environment or oauth source.");
    }
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(credential.variable)) {
        throw new Error("Credential variable must be an uppercase environment variable name.");
    }
    if (/(?:OAUTH|REFRESH|SESSION|COOKIE)/u.test(credential.variable)) {
        throw new Error("OAuth, refresh-token, browser-session, and cookie credentials are not accepted as environment API keys; use credential source \"oauth\".");
    }
}
function validateEndpoint(raw, provider) {
    if (raw === undefined || raw.length === 0) {
        throw new Error(`${provider} provider config requires an endpoint.`);
    }
    let endpoint;
    try {
        endpoint = new URL(raw);
    }
    catch {
        throw new Error("Provider endpoint must be an absolute HTTP(S) URL.");
    }
    if (endpoint.username.length > 0 || endpoint.password.length > 0) {
        throw new Error("Provider endpoints must not contain embedded credentials.");
    }
    if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
        throw new Error("Provider endpoints must not contain query parameters or fragments.");
    }
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) {
        throw new Error("Provider endpoints require HTTPS; plain HTTP is allowed only for loopback development endpoints.");
    }
    return endpoint.toString();
}
