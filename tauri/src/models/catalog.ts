// Model catalog: per-provider model lists, the OpenRouter cache, the
// useModelCatalog hook, and the custom-provider localStorage keys
// (extracted from App.tsx).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OllamaDiscovery } from "../state/events";
import { fmtBytes } from "../lib/format";

// ─── Model catalog: every provider lists its models ────────────────────────

export interface ModelOption {
  id: string;
  label?: string;
  hint?: string;
  group: string;
  capabilities?: string[];
  /** Rich prose (OpenRouter) shown on the discovery card. */
  description?: string;
  /** Context window in tokens (OpenRouter) — shown as a big stat on the detail page. */
  contextLength?: number;
  /** $ per million tokens (OpenRouter): input = prompt, output = completion. */
  pricing?: { input?: number; output?: number };
  /** Ollama library meta: human pull count ("225.9K") + relative updated age. */
  pulls?: string;
  updated?: string;
  /** The reasoning-effort rungs this model actually honours, discovered by the
   *  daemon (see effortLadderFor). The effort panel renders EXACTLY these —
   *  never a hardcoded ladder. [] = no extended thinking, so the dial hides;
   *  undefined = not yet discovered, client falls back to its heuristic. */
  effortLevels?: string[];
}

export const OLLAMA_CLOUD_MODELS: ModelOption[] = [
  { id: "qwen3-coder:480b-cloud", hint: "top coding reasoner", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "qwen3-coder-next:cloud", hint: "agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "qwen3.5:397b-cloud", hint: "large multimodal reasoner", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning", "vision"] },
  { id: "qwen3.5:cloud", hint: "cloud default", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "qwen3-next:80b-cloud", hint: "efficient thinking", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-pro:cloud", hint: "frontier agentic reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-flash:cloud", hint: "fast long-context reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v3.2:cloud", hint: "efficient reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v3.1:671b-cloud", hint: "hybrid thinking", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "glm-5.1:cloud", hint: "flagship agentic engineering", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "glm-5:cloud", hint: "complex systems engineering", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "glm-4.7:cloud", hint: "coding capability", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "glm-4.6:cloud", hint: "agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "kimi-k2.6:cloud", hint: "multimodal agentic coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning", "vision"] },
  { id: "kimi-k2.5:cloud", hint: "multimodal agentic", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning", "vision"] },
  { id: "kimi-k2:1t-cloud", hint: "long-horizon coding", group: "Ollama Cloud · coding", capabilities: ["tools", "reasoning"] },
  { id: "kimi-k2-thinking:cloud", hint: "thinking model", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "minimax-m2.7:cloud", hint: "coding and productivity", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2.5:cloud", hint: "productivity coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2.1:cloud", hint: "multilingual coding", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "minimax-m2:cloud", hint: "efficient agentic workflows", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "gpt-oss:120b-cloud", hint: "open reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "devstral-2:123b-cloud", hint: "codebase agents", group: "Ollama Cloud · coding", capabilities: ["tools"] },
  { id: "mistral-large-3:675b-cloud", hint: "enterprise multimodal", group: "Ollama Cloud · general", capabilities: ["tools", "vision"] },
  { id: "nemotron-3-super:cloud", hint: "multi-agent reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "cogito-2.1:671b-cloud", hint: "general reasoning", group: "Ollama Cloud · reasoning", capabilities: ["tools", "reasoning"] },
  { id: "devstral-small-2:24b-cloud", hint: "fast codebase editing", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "nemotron-3-nano:30b-cloud", hint: "efficient agentic work", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "qwen3-vl:235b-instruct-cloud", hint: "multimodal instruction", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "rnj-1:8b-cloud", hint: "code and STEM utility", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gpt-oss:20b-cloud", hint: "quick summaries", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gemma3:4b-cloud", hint: "compact vision utility", group: "Ollama Cloud · fast", capabilities: ["vision"] },
  { id: "ministral-3:3b-cloud", hint: "small utility", group: "Ollama Cloud · fast", capabilities: ["tools"] },
  { id: "gemini-3-flash-preview:cloud", hint: "fast multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "gemma4:31b-cloud", hint: "multimodal reasoning", group: "Ollama Cloud · vision", capabilities: ["reasoning", "vision"] },
  { id: "gemma3:27b-cloud", hint: "capable vision model", group: "Ollama Cloud · vision", capabilities: ["vision"] },
  { id: "gemma3:12b-cloud", hint: "balanced vision model", group: "Ollama Cloud · vision", capabilities: ["vision"] },
  { id: "qwen3-vl:235b-cloud", hint: "vision-language reasoning", group: "Ollama Cloud · vision", capabilities: ["tools", "reasoning", "vision"] },
  { id: "ministral-3:14b-cloud", hint: "edge-capable multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
  { id: "ministral-3:8b-cloud", hint: "small multimodal", group: "Ollama Cloud · vision", capabilities: ["tools", "vision"] },
];

export const OPENAI_MODELS: ModelOption[] = [
  // Verified working through ChatGPT Codex OAuth. The daemon live-fetches the
  // account's real list; this is the offline fallback.
  { id: "gpt-5.6-sol", label: "5.6 Sol", hint: "flagship — deepest reasoning", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
  { id: "gpt-5.6-terra", label: "5.6 Terra", hint: "balanced — ~5.5 quality, 2× cheaper", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
  { id: "gpt-5.5", label: "5.5", hint: "previous flagship", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
  { id: "gpt-5.4", label: "5.4", hint: "stable baseline", group: "OpenAI", capabilities: ["tools", "reasoning"] },
  { id: "gpt-5.4-mini", label: "5.4 Mini", hint: "fast + cheap", group: "OpenAI", capabilities: ["tools"] },
  { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark", hint: "agentic coding tuned", group: "OpenAI", capabilities: ["tools", "reasoning"] },
];

export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", hint: "flagship — adaptive extended thinking", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-opus-5", label: "Claude Opus 5", hint: "newest Opus — deepest reasoning", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "frontier Sonnet — coding + agents", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "deep reasoning workhorse — 1M context", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "prior Opus — deep reasoning", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "earlier Opus", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "balanced speed / depth", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "fastest — cheap + capable", group: "Anthropic", capabilities: ["tools", "vision"] },
];

export const DEEPSEEK_MODELS: ModelOption[] = [
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", hint: "frontier coding + reasoning · 1M context", group: "DeepSeek", capabilities: ["tools", "reasoning"] },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", hint: "fast agentic reasoning · 1M context", group: "DeepSeek", capabilities: ["tools", "reasoning"] },
];

export const MOCK_MODELS: ModelOption[] = [{ id: "mock-echo", hint: "offline echo provider for UI testing", group: "Mock" }];

export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  ollama: OLLAMA_CLOUD_MODELS[0].id,
  openai: OPENAI_MODELS[0].id,
  anthropic: ANTHROPIC_MODELS[0].id,
  deepseek: DEEPSEEK_MODELS[0].id,
  openrouter: "openai/gpt-4o-mini",
  ares: "ares-internal",
  mock: MOCK_MODELS[0].id,
};

export function defaultModelForProvider(provider: string): string {
  return PROVIDER_DEFAULT_MODELS[provider] ?? "";
}

export let openRouterCache: ModelOption[] | null = null;

export async function fetchOpenRouterModels(): Promise<ModelOption[]> {
  if (openRouterCache) return openRouterCache;
  const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{
      id?: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      description?: string;
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[] };
    }>;
  };
  const models = (body.data ?? [])
    .filter((m): m is typeof m & { id: string } => Boolean(m.id))
    .map((m) => {
      const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k ctx` : "";
      const inPrice = m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined;
      const outPrice = m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : undefined;
      const price = inPrice !== undefined ? `$${inPrice.toFixed(2)}/M in` : "";
      const capabilities = [
        ...(m.supported_parameters ?? []).filter((p) => p === "tools" || p === "reasoning" || p === "structured_outputs"),
        ...((m.architecture?.input_modalities ?? []).includes("image") ? ["vision"] : []),
        ...(Number(m.pricing?.prompt ?? "1") === 0 ? ["free"] : []),
      ];
      return {
        id: m.id,
        label: m.name,
        hint: [ctx, price].filter(Boolean).join(" · "),
        group: "OpenRouter",
        capabilities: [...new Set(capabilities)],
        description: m.description?.trim() || undefined,
        contextLength: m.context_length,
        pricing: (inPrice !== undefined || outPrice !== undefined) ? { input: inPrice, output: outPrice } : undefined,
      };
    });
  models.sort((a, b) => a.id.localeCompare(b.id));
  openRouterCache = models;
  return models;
}

export function mergeModelOptions(...lists: ModelOption[][]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const list of lists) {
    for (const model of list) {
      const prior = byId.get(model.id);
      byId.set(model.id, {
        ...prior,
        ...model,
        capabilities: [...new Set([...(prior?.capabilities ?? []), ...(model.capabilities ?? [])])],
      });
    }
  }
  return [...byId.values()];
}

export function useModelCatalog(provider: string, native: boolean) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    const onCatalog = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string; models?: ModelOption[] }>).detail;
      if (!live || detail?.provider !== provider || !Array.isArray(detail.models)) return;
      setModels((current) => mergeModelOptions(current, detail.models ?? []));
      if (provider === "ares") setLoading(false);
    };
    const requestDaemonCatalog = () => {
      if (!native) return;
      void invoke("ares_daemon_command", { command: { type: "model_catalog", provider } }).catch(() => null);
    };
    const onDaemonReady = () => requestDaemonCatalog();
    window.addEventListener("ares:model-catalog", onCatalog);
    window.addEventListener("ares:daemon-ready", onDaemonReady);

    const run = async () => {
      if (provider === "mock") {
        setModels(MOCK_MODELS);
        return;
      }
      if (provider === "custom") {
        // Models discovered from the owner's custom OpenAI-compatible endpoint
        // (Settings → Keys → Custom provider). Empty until they run Discover.
        setModels(readCustomModels().map((id) => ({ id, group: "Custom provider" })));
        return;
      }
      if (provider === "openai") {
        // Same live-list pattern as anthropic: the daemon asks the signed-in
        // ChatGPT/Codex account for the REAL model ids and we merge them in.
        setModels(OPENAI_MODELS);
        requestDaemonCatalog();
        return;
      }
      if (provider === "anthropic") {
        // Seed with the curated list, then ask the daemon for the LIVE model
        // list (it queries the Anthropic models API with the stored key and
        // falls back to its own static catalog when unauthed/offline). This
        // branch used to return without asking — which meant a newly released
        // model never appeared until someone hand-edited this file.
        setModels(ANTHROPIC_MODELS);
        requestDaemonCatalog();
        return;
      }
      if (provider === "ares") {
        // The Ares tab lists ONLY what the gateway granted this account —
        // white-labeled display names, never the local ollama/openai catalogs.
        setModels([]);
        if (native) {
          setLoading(true);
          requestDaemonCatalog();
        } else {
          setModels([{ id: "ares-internal", hint: "connect your account — get a token at doingteam.com → Account", group: "Ares Gateway" }]);
        }
        return;
      }
      if (provider === "deepseek") {
        setModels(DEEPSEEK_MODELS);
        requestDaemonCatalog();
        return;
      }
      if (provider === "kimi") {
        // Static row instantly; the daemon merges the live account catalog.
        setModels([{ id: "kimi-for-coding", label: "Kimi for Coding", hint: "agentic coding · 256K context", group: "Kimi", capabilities: ["tools", "reasoning"] }]);
        requestDaemonCatalog();
        return;
      }
      if (provider === "openrouter") {
        setLoading(true);
        setModels([]);
        requestDaemonCatalog();
        try {
          const fetched = await fetchOpenRouterModels();
          if (live) setModels(fetched);
        } catch (err) {
          if (live) {
            setError(String(err instanceof Error ? err.message : err));
            setModels([]);
          }
        } finally {
          if (live) setLoading(false);
        }
        return;
      }
      if (provider === "moa") {
        // Ensembles come from the daemon catalog ("Mixture of Agents" group).
        setModels([]);
        requestDaemonCatalog();
        return;
      }
      // ollama: curated cloud + whatever is installed locally
      setModels(OLLAMA_CLOUD_MODELS);
      requestDaemonCatalog();
      if (!native) return;
      setLoading(true);
      try {
        const found = await invoke<OllamaDiscovery>("ares_ollama_models");
        if (!live) return;
        const local = (found.models ?? []).map((m) => ({
          id: m.id,
          hint: [m.hint, fmtBytes(m.size)].filter(Boolean).join(" · "),
          group: "Local Ollama",
          capabilities: m.capabilities ?? [],
        }));
        setModels((current) => mergeModelOptions(current, local));
        // Local daemon down is NORMAL for cloud-key users — say so gently
        // instead of surfacing the raw "connection timed out" as an error
        // banner over a perfectly usable cloud + library catalog.
        if (found.error && !found.reachable) {
          setError("Local Ollama isn't running — showing cloud + library models. Start the Ollama app to use your pulled models.");
        }
      } catch (err) {
        if (live) setError(String(err));
      } finally {
        if (live) setLoading(false);
      }
    };
    void run();
    return () => {
      live = false;
      window.removeEventListener("ares:model-catalog", onCatalog);
      window.removeEventListener("ares:daemon-ready", onDaemonReady);
    };
  }, [provider, native]);

  return { models, loading, error };
}

// ─── Custom (OpenAI-compatible) provider: bring-your-own URL + key + discovery ──
// Point Ares at ANY OpenAI-compatible endpoint and pull its full model list from
// {base}/models. Self-contained: persists base URL + discovered models in
// localStorage (so the model picker can offer them) and ships key+url+model to the
// daemon via the provider_key command.
export const CUSTOM_BASE_LS = "ares.custom.baseUrl";
export const CUSTOM_MODELS_LS = "ares.custom.models";
export const CUSTOM_MODEL_LS = "ares.custom.model";

export function readCustomModels(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CUSTOM_MODELS_LS) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
