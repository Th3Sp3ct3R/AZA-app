export const PROVIDER_CHOICES = [
    {
        id: "kimi",
        label: "Kimi Code",
        auth: ["oauth"],
        credentialVariable: "KIMI_API_KEY",
        models: [
            { id: "kimi-for-coding", note: "subscription default" },
        ],
    },
    {
        id: "anthropic",
        label: "Anthropic",
        auth: ["oauth", "api-key"],
        credentialVariable: "ANTHROPIC_API_KEY",
        models: [
            { id: "claude-opus-4-8", note: "most capable" },
            { id: "claude-sonnet-5", note: "balanced" },
            { id: "claude-fable-5" },
            { id: "claude-haiku-4-5-20251001", note: "fastest" },
        ],
    },
    {
        id: "openai",
        label: "OpenAI",
        auth: ["oauth", "api-key"],
        credentialVariable: "OPENAI_API_KEY",
        models: [
            { id: "gpt-5.6", note: "most capable" },
            { id: "gpt-5.6-codex", note: "coding" },
            { id: "gpt-5-mini", note: "fastest" },
        ],
        oauthModels: [
            { id: "gpt-5.6-sol", note: "flagship — deepest reasoning" },
            { id: "gpt-5.6-terra", note: "balanced — 2× cheaper" },
            { id: "gpt-5.5", note: "previous flagship" },
            { id: "gpt-5.3-codex-spark", note: "agentic coding tuned" },
            { id: "gpt-5.4-mini", note: "fast + cheap" },
        ],
    },
    {
        id: "deepseek",
        label: "DeepSeek",
        auth: ["api-key"],
        credentialVariable: "DEEPSEEK_API_KEY",
        models: [
            { id: "deepseek-v4-pro", note: "most capable" },
            { id: "deepseek-chat" },
            { id: "deepseek-reasoner", note: "reasoning" },
        ],
    },
    {
        id: "ollama",
        label: "Ollama",
        auth: ["api-key"],
        credentialVariable: "OLLAMA_API_KEY",
        models: [
            { id: "glm-5.2:cloud", note: "cloud · long-horizon flagship" },
            { id: "kimi-k2.7-code:cloud", note: "cloud · agentic coding" },
            { id: "deepseek-v4-pro:cloud", note: "cloud · coding + reasoning" },
            { id: "qwen3-coder:30b", note: "local · coding" },
            { id: "gpt-oss:120b", note: "local" },
            { id: "llama3.3", note: "local" },
        ],
    },
];
export function providerChoice(provider) {
    const choice = PROVIDER_CHOICES.find((candidate) => candidate.id === provider);
    if (choice === undefined)
        throw new Error(`Unknown provider: ${provider}`);
    return choice;
}
export function catalogModels(provider, auth) {
    const choice = providerChoice(provider);
    return auth === "oauth" && choice.oauthModels !== undefined ? choice.oauthModels : choice.models;
}
export function supportsOAuth(provider) {
    return providerChoice(provider).auth.includes("oauth");
}
export function defaultModel(provider) {
    const first = providerChoice(provider).models[0];
    if (first === undefined)
        throw new Error(`Provider ${provider} has no catalog models.`);
    return first.id;
}
export function credentialVariable(provider) {
    return providerChoice(provider).credentialVariable;
}
export function parseSelectableProvider(value) {
    const normalized = value.trim().toLowerCase();
    return PROVIDER_CHOICES.find((choice) => choice.id === normalized)?.id;
}
const CONTEXT_WINDOW_TOKENS = [
    ["claude-", 200_000],
    ["gpt-5", 256_000],
    ["deepseek-", 128_000],
    ["kimi-", 256_000],
];
const BYTES_PER_TOKEN = 2.5;
const WINDOW_DUTY_FACTOR = 0.6;
const FALLBACK_CONTEXT_BYTES = 2_000_000;
export function defaultContextBytes(model) {
    const normalized = model.trim().toLowerCase();
    const entry = CONTEXT_WINDOW_TOKENS.find(([prefix]) => normalized.startsWith(prefix));
    if (entry === undefined)
        return FALLBACK_CONTEXT_BYTES;
    return Math.min(FALLBACK_CONTEXT_BYTES, Math.floor(entry[1] * BYTES_PER_TOKEN * WINDOW_DUTY_FACTOR));
}
export function contextWindowTokens(model) {
    const normalized = model.trim().toLowerCase();
    return CONTEXT_WINDOW_TOKENS.find(([prefix]) => normalized.startsWith(prefix))?.[1];
}
