// Extracted from entry.ts — providers.

import { MockEchoProvider, OpenAIResponsesProvider, OpenRouterProvider, DeepSeekProvider, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL, OllamaCloudPool, DEFAULT_OLLAMA_SLOTS, OLLAMA_CLOUD_MODELS, fetchOllamaLibraryModels, fetchDeepSeekModels, fetchOpenRouterModels, fetchAnthropicModels, fetchCodexModels, loadAuthToken, MoaProvider, type MoaMember, type Provider } from "@ares/core";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { type SubModelPool } from "@ares/tools";
import { loadUiSettings, type UiSettings } from "../uiSettings.js";

// Ares talks to the LOCAL Ollama daemon (native /api/chat) by default — it
// proxies :cloud models via your `ollama signin`. We do NOT auto-flip into
// Anthropic-compat from stray ANTHROPIC_* env (those are common from other
// tools and would hijack the call into a key-required endpoint → 401). Compat
// is opt-in only via ARES_OLLAMA_ANTHROPIC_COMPAT=1.
export const NATIVE_OLLAMA_OPTS = {
  useAnthropicCompat: process.env.ARES_OLLAMA_ANTHROPIC_COMPAT === "1",
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
} as const;

export interface ProviderSelection {
  provider: Provider;
  model: string;
  source: string;
  /** Canonical product-facing provider identity. Never infer this from the
   * transport adapter: Ares and DeepSeek both deliberately reuse the hardened
   * Anthropic wire client, but they are not Anthropic accounts. */
  family?: TerminalProviderId;
  /** Cheap validation run before a user-selected model is committed. */
  preflight?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  subModel?: SubModelPool;
}

/** The cheap/fast model id ON THE SAME PROVIDER for fan-out work (explorer
 *  subagents) — searching doesn't need the frontier model. Returns undefined
 *  when the family has no cheaper sibling (fan-out then inherits the parent). */
export function fastModelFor(selection: ProviderSelection): string | undefined {
  const m = selection.model.toLowerCase();
  if (m.includes("deepseek") && !m.includes("flash")) return "deepseek-v4-flash";
  if (m.startsWith("claude-") && !m.includes("haiku")) return "claude-haiku-4-5-20251001";
  if (m === "ares-internal" || m === "balanced" || m === "max") return "fast"; // gateway tier
  return undefined;
}

interface DaemonModelOption {
  id: string;
  label?: string;
  hint?: string;
  group: string;
  capabilities?: string[];
  /** Rich prose (OpenRouter) for the discovery cards. */
  description?: string;
  /** Structured stats for the discovery panel (the hint string keeps a packed
   *  copy for old clients, but the UI wants real numbers). */
  contextLength?: number;
  pricing?: { input?: number; output?: number };
  /** Ollama library meta: human pull count + relative updated age. */
  pulls?: string;
  updated?: string;
}

export const TERMINAL_PROVIDERS = ["ollama", "openai", "anthropic", "deepseek", "kimi", "openrouter", "ares", "custom", "moa", "mock"] as const;

// Mixture-of-Agents ensembles — pickable "models" under the `moa` provider.
// Each reference drafts independently; the aggregator (tool-capable) synthesizes.
// Members route through whatever provider they name — unconfigured ones simply
// drop out of the committee (graceful), so an ensemble is useful the moment the
// user has ANY of its members keyed.
interface MoaEnsembleSpec {
  label: string;
  hint: string;
  references: Array<{ provider: string; model: string; label: string }>;
  aggregator: { provider: string; model: string };
}
export const MOA_ENSEMBLES: Record<string, MoaEnsembleSpec> = {
  "moa-council": {
    label: "MoA · Frontier Council",
    hint: "3 frontier drafts → 1 synthesis",
    references: [
      { provider: "ares", model: "ares-internal", label: "Ares house" },
      { provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL, label: "Claude" },
      { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek" },
    ],
    aggregator: { provider: "ares", model: "ares-internal" },
  },
  "moa-lite": {
    label: "MoA · Lite",
    hint: "2 cheap drafts → 1 synthesis",
    references: [
      { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek" },
      { provider: "openrouter", model: "openai/gpt-4o-mini", label: "GPT-4o-mini" },
    ],
    aggregator: { provider: "ares", model: "ares-internal" },
  },
};

export type TerminalProviderId = (typeof TERMINAL_PROVIDERS)[number];

export const ROUTE_LANES = ["chat", "coding", "research", "tool-use"] as const;

const STATIC_MODEL_CATALOG: Record<"openai" | "anthropic" | "mock", DaemonModelOption[]> = {
  openai: [
    // Verified working through ChatGPT Codex OAuth (probed live). Luna and the
    // bare gpt-5.6 alias are NOT supported on a ChatGPT account (API-only), so
    // they're omitted. The daemon also live-fetches the account's real list;
    // this is the fallback when signed out / the endpoint is unreachable.
    { id: "gpt-5.6-sol", label: "5.6 Sol", hint: "flagship — deepest reasoning", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
    { id: "gpt-5.6-terra", label: "5.6 Terra", hint: "balanced — ~5.5 quality, 2× cheaper", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
    { id: "gpt-5.5", label: "5.5", hint: "previous flagship", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
    { id: "gpt-5.4", label: "5.4", hint: "stable baseline", group: "OpenAI", capabilities: ["tools", "reasoning"] },
    { id: "gpt-5.4-mini", label: "5.4 Mini", hint: "fast + cheap", group: "OpenAI", capabilities: ["tools"] },
    { id: "gpt-5.3-codex-spark", label: "5.3 Codex Spark", hint: "agentic coding tuned", group: "OpenAI", capabilities: ["tools", "reasoning"] },
  ],
  anthropic: [
    { id: "claude-fable-5", label: "Claude Fable 5", hint: "flagship · adaptive extended thinking", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "frontier Sonnet · coding + agents", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "deep reasoning workhorse · 1M context", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "prior Opus · deep reasoning", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "earlier Opus", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "balanced speed / depth", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "fastest · cheap + capable", group: "Anthropic", capabilities: ["tools", "vision"] },
  ],
  mock: [{ id: "mock-echo", hint: "offline echo provider for UI testing", group: "Mock", capabilities: [] }],
};

export function isTerminalProviderId(provider: string): provider is TerminalProviderId {
  return (TERMINAL_PROVIDERS as readonly string[]).includes(provider);
}

/** The Ares Gateway base URL (the owner's accounts site). Normalizes the bare
 *  apex doingteam.com → www: the apex 307-redirects to www, and fetch DROPS the
 *  Authorization header on that cross-subdomain hop, so the token never arrives
 *  ("token rejected"). Talk to the canonical host directly — no redirect. */
export function aresGatewayBase(settings: UiSettings): string {
  const raw = (settings.aresGatewayUrl || process.env.ARES_GATEWAY_URL || "https://www.doingteam.com").replace(/\/+$/, "");
  return raw.replace(/^(https?:\/\/)doingteam\.com/i, "$1www.doingteam.com");
}

export interface AresGatewayMe {
  profile?: { display_name?: string | null; avatar_url?: string | null; status?: string; hide_providers?: boolean };
  balance_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  models?: Array<{ id: string; display_name?: string; is_free?: boolean; is_house?: boolean }>;
  new_grants?: Array<{ amount_usd?: number; reason?: string | null; at?: string }>;
  server_time?: string;
}

/** Account snapshot (+ grant deltas since a cursor) from the gateway /me. */
export async function fetchAresGatewayMe(
  base: string,
  token: string,
  since?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AresGatewayMe | null> {
  const url = `${base}/api/gateway/v1/me${since ? `?since=${encodeURIComponent(since)}` : ""}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as AresGatewayMe | null;
}

/** Live entitled-model list from the gateway — what THIS account may use.
 *  Friendly single-row hints when not connected; injectable fetch for tests. */
export async function fetchAresGatewayModels(
  base: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonModelOption[]> {
  if (!token) {
    return [{ id: "ares-internal", hint: "connect your account — get a token at doingteam.com → Account", group: "Ares Gateway", capabilities: [] }];
  }
  const res = await fetchImpl(`${base}/api/gateway/v1/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }).catch(() => null);
  if (!res || res.status === 401) {
    return [{ id: "ares-internal", hint: "token rejected — reconnect at doingteam.com → Account", group: "Ares Gateway", capabilities: [] }];
  }
  if (!res.ok) return [];
  const payload = (await res.json().catch(() => ({}))) as {
    models?: Array<{ id: string; display_name?: string; is_free?: boolean; is_house?: boolean }>;
  };
  const granted = payload.models ?? [];
  const house = granted.find((m) => m.is_house);
  const rows: DaemonModelOption[] = granted.map((m) => ({
    id: m.id,
    label: m.display_name,
    hint: [m.is_house ? "in house" : "", m.is_free ? "FREE" : ""].filter(Boolean).join(" · "),
    group: "Ares Gateway",
    capabilities: ["tools", "reasoning"],
  }));
  // A friendly default that always works: "ares-internal" is the sentinel the
  // gateway resolves to the house model. Surface it as a named row so the
  // picker/footer never show a raw id and picking Ares needs no extra step.
  rows.unshift({
    id: "ares-internal",
    label: house?.display_name ? `${house.display_name} (default)` : "Ares (in house)",
    hint: "default · routes to your in-house model",
    group: "Ares Gateway",
    capabilities: ["tools", "reasoning"],
  });
  return rows;
}

/** Discover an OpenAI-compatible endpoint's model list SERVER-SIDE (from the
 *  daemon, not the webview) so CORS / browser-origin blocks — the reason
 *  NVIDIA, Google AI Studio, and most hosted providers "decline" a webview
 *  fetch — never apply. Returns sorted model ids or a readable error. */
export async function fetchCustomOpenAiModels(
  base: string,
  key: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const root = (base || "").trim().replace(/\/+$/, "");
  if (!root) return { ok: false, error: "enter a base URL first" };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key && key.trim()) headers.Authorization = `Bearer ${key.trim()}`;
  const res = await fetchImpl(`${root}/models`, { headers }).catch((e) => {
    return { ok: false, _err: e instanceof Error ? e.message : String(e) } as unknown as Response;
  });
  if (!("status" in res)) return { ok: false, error: `couldn't reach ${root}/models` };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `HTTP ${res.status} — the key was rejected. Check it's valid and unrestricted (no HTTP-referrer / IP limits) for this API.` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${root}/models` };
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[]; models?: unknown[] };
  const list = (body.data ?? body.models ?? []) as Array<string | { id?: string }>;
  const models = list
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) return { ok: false, error: "the endpoint returned no models" };
  return { ok: true, models };
}

/** Ship a full session transcript to the gateway as a bug report. Opt-in only
 *  (the user presses "Report bug"). Returns the new report id or an error the
 *  UI shows in a toast. Injectable fetch for tests. */
export async function postAresGatewayReport(
  base: string,
  token: string | undefined,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "connect your Ares account first (doingteam.com → Account)" };
  // Coding transcripts run to tens of MB — far past the platform's ~4.5MB
  // request-body limit ("Request Entity Too Large"). gzip shrinks text ~10x so
  // it fits; the gateway inflates it (x-ares-encoding: gzip).
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const res = await fetchImpl(`${base}/api/gateway/v1/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ares-encoding": "gzip",
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    body: gz,
  }).catch(() => null);
  if (!res) return { ok: false, error: "couldn't reach the Ares gateway" };
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: unknown };
  if (!res.ok) {
    // The gateway may return a bare {error:string} or the Anthropic error shape
    // {error:{message}} — unwrap either into a readable line for the toast.
    const e = data.error;
    const msg = typeof e === "string" ? e : (e as { message?: string } | undefined)?.message;
    return { ok: false, error: msg || `gateway returned ${res.status}` };
  }
  return { ok: true, id: String(data.id ?? "") };
}

export function defaultTerminalModel(provider: string, settings: UiSettings): string {
  switch (provider) {
    case "openai":
      return settings.lastOpenAIModel ?? STATIC_MODEL_CATALOG.openai[0].id;
    case "anthropic":
      return settings.lastAnthropicModel ?? STATIC_MODEL_CATALOG.anthropic[0].id;
    case "deepseek":
      return settings.lastDeepSeekModel ?? "deepseek-v4-pro";
    case "ares":
      return settings.lastAresModel ?? "ares-internal";
    case "openrouter":
      return settings.lastOpenRouterModel ?? "openai/gpt-4o-mini";
    case "mock":
      return "mock-echo";
    case "ollama":
    default:
      return settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model;
  }
}

/** Build a live model catalog without exposing provider keys to the webview. */
export async function daemonModelCatalog(provider: string): Promise<DaemonModelOption[]> {
  const settings = await loadUiSettings();

  if (provider === "mock") {
    return STATIC_MODEL_CATALOG.mock;
  }

  if (provider === "openai") {
    // Ask the authenticated ChatGPT/Codex account for its REAL model list —
    // exact ids the backend accepts, never guessed from display labels or an
    // app-update-stale hardcoded list. Falls back to the static catalog when
    // signed out or the endpoint is unreachable.
    const live = await fetchCodexModels().catch(() => []);
    if (live.length > 0) {
      const staticHints = new Map(STATIC_MODEL_CATALOG.openai.map((m) => [m.id, m]));
      return live.map((m) => {
        const known = staticHints.get(m.id);
        return {
          id: m.id,
          label: m.label ?? known?.label ?? m.id,
          hint: m.description?.slice(0, 80) ?? known?.hint ?? "",
          group: "OpenAI",
          capabilities: known?.capabilities ?? ["tools", "reasoning", "vision"],
          description: m.description,
        };
      });
    }
    return STATIC_MODEL_CATALOG.openai;
  }

  if (provider === "moa") {
    // Ensembles appear as pickable models under "Mixture of Agents".
    return Object.entries(MOA_ENSEMBLES).map(([id, spec]) => ({
      id,
      label: spec.label,
      hint: spec.hint,
      group: "Mixture of Agents",
      capabilities: ["tools", "reasoning"],
      description: `An ensemble: ${spec.references.map((r) => r.label).join(", ")} each draft independently, then a synthesizer produces the final answer. Unconfigured members drop out gracefully.`,
    }));
  }

  if (provider === "anthropic") {
    // Live-fetch-with-static-fallback, same pattern as the deepseek branch below:
    // an unreachable/unauthed Anthropic API silently falls back to the curated
    // static catalog rather than returning an empty list.
    const live = await fetchAnthropicModels(settings.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ARES_ANTHROPIC_API_KEY || "").catch(() => []);
    if (live.length === 0) return STATIC_MODEL_CATALOG.anthropic;
    const staticHints = new Map(STATIC_MODEL_CATALOG.anthropic.map((m) => [m.id, m]));
    return live.map((model: { id: string; label?: string }) => {
      const known = staticHints.get(model.id);
      return {
        id: model.id,
        label: model.label ?? known?.hint,
        hint: known?.hint ?? model.label ?? "",
        group: "Anthropic",
        capabilities: known?.capabilities ?? ["tools", "reasoning"],
      };
    });
  }

  if (provider === "openrouter") {
    const rows = await fetchOpenRouterModels().catch(() => []);
    return rows.map((model) => ({
      id: model.id,
      label: model.name,
      hint: [
        model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : "",
        model.promptPrice ? `$${(Number(model.promptPrice) * 1e6).toFixed(2)}/M in` : "",
      ].filter(Boolean).join(" · "),
      group: "OpenRouter",
      capabilities: [
        ...(model.supportedParameters ?? []).filter((item) => item === "tools" || item === "reasoning" || item === "structured_outputs"),
        ...((model.inputModalities ?? []).includes("image") ? ["vision"] : []),
        ...(Number(model.promptPrice ?? "1") === 0 ? ["free"] : []),
      ],
      // OpenRouter ships a rich blurb per model — the heart of the discovery UI.
      description: model.description?.trim() || undefined,
      contextLength: model.contextLength || undefined,
      pricing: {
        input: model.promptPrice != null ? Number(model.promptPrice) * 1e6 : undefined,
        output: model.completionPrice != null ? Number(model.completionPrice) * 1e6 : undefined,
      },
    }));
  }

  if (provider === "deepseek") {
    const live = await fetchDeepSeekModels({ apiKey: settings.deepSeekKey }).catch(() => []);
    const rows = live.length > 0
      ? live
      : [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }];
    return rows.map((model) => ({
      id: model.id,
      label: model.id === "deepseek-v4-pro" ? "DeepSeek V4 Pro" : model.id === "deepseek-v4-flash" ? "DeepSeek V4 Flash" : model.id,
      hint: model.id.includes("flash") ? "fast agentic reasoning · 1M context" : "frontier coding + reasoning · 1M context",
      group: "DeepSeek",
      capabilities: ["tools", "reasoning"],
    }));
  }

  if (provider === "kimi") {
    // Live discovery from the signed-in Kimi account (via the embedded
    // Vanguard module, which owns the OAuth store) — surfaces the account's
    // real roster (kimi-for-coding, k3, ...). Static row otherwise so the
    // picker is never empty.
    const KIMI_LABELS: Record<string, string> = {
      "kimi-for-coding": "Kimi for Coding",
      "kimi-for-coding-highspeed": "Kimi for Coding · Highspeed",
      k3: "Kimi K3",
    };
    const kimiLabel = (id: string): string =>
      KIMI_LABELS[id] ?? `Kimi ${id.replace(/^kimi-/u, "").replace(/\bk(\d)/u, "K$1")}`;
    try {
      const vanguard = await import("vanguard") as {
        fetchKimiModels: () => Promise<ReadonlyArray<{
          id: string; contextLength?: number; supportsReasoning?: boolean; thinkingType?: string;
        }> | null>;
      };
      const live = await vanguard.fetchKimiModels().catch(() => null);
      if (live !== null && live.length > 0) {
        return live.map((model) => ({
          id: model.id,
          label: kimiLabel(model.id),
          hint: [
            model.supportsReasoning === false || model.thinkingType === "no" ? "fast, no extended thinking" : "agentic coding + reasoning",
            model.contextLength !== undefined ? `${Math.round(model.contextLength / 1024)}K context` : undefined,
          ].filter(Boolean).join(" · "),
          group: "Kimi",
          capabilities: model.supportsReasoning === false ? ["tools"] : ["tools", "reasoning"],
          ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
        }));
      }
    } catch {
      // vanguard module unavailable or signed out — fall through to static
    }
    return [{
      id: "kimi-for-coding",
      label: "Kimi for Coding",
      hint: "agentic coding · 256K context",
      group: "Kimi",
      capabilities: ["tools", "reasoning"],
    }];
  }

  if (provider === "ares") {
    return fetchAresGatewayModels(aresGatewayBase(settings), settings.aresGatewayToken);
  }

  if (provider !== "ollama") return [];

  const byId = new Map<string, DaemonModelOption>();
  const put = (model: DaemonModelOption) => {
    const prior = byId.get(model.id);
    byId.set(model.id, {
      ...prior,
      ...model,
      capabilities: [...new Set([...(prior?.capabilities ?? []), ...(model.capabilities ?? [])])],
    });
  };

  for (const model of OLLAMA_CLOUD_MODELS) {
    put({
      id: model.id,
      hint: model.hint,
      group: `Ollama Cloud · ${model.role}`,
      capabilities: model.role === "reasoner" ? ["tools", "reasoning"] : ["tools"],
    });
  }

  if (settings.ollamaApiKey || process.env.OLLAMA_API_KEY) {
    const apiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY || "";
    const response = await fetch("https://ollama.com/api/tags", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);
    if (response?.ok) {
      const payload = await response.json() as {
        models?: Array<{
          name?: string;
          model?: string;
          size?: number;
          details?: { parameter_size?: string; family?: string };
        }>;
      };
      for (const row of payload.models ?? []) {
        const id = row.name ?? row.model;
        if (!id) continue;
        put({
          id,
          hint: [row.details?.parameter_size, row.details?.family].filter(Boolean).join(" · "),
          group: "Ollama Cloud · live",
          capabilities: ["tools"],
        });
      }
    }
  }

  // The FULL public library (ollama.com/library) — every model, pulled or not,
  // with the same blurb/pulls/updated meta the website shows. Degrades to
  // nothing on network failure; never blocks the rest of the catalog.
  const library = await fetchOllamaLibraryModels().catch(() => []);
  for (const entry of library) {
    if (entry.capabilities.includes("embedding")) continue; // not chat-pickable
    const caps = [
      ...(entry.capabilities.includes("tools") ? ["tools"] : []),
      ...(entry.capabilities.includes("thinking") ? ["reasoning"] : []),
      ...(entry.capabilities.includes("vision") ? ["vision"] : []),
    ];
    put({
      // Cloud-hosted library models run as name:cloud; local-only ones by name
      // (which works once pulled — the UI shows pulled state).
      id: entry.cloud ? `${entry.name}:cloud` : entry.name,
      label: entry.name,
      hint: [entry.pulls ? `${entry.pulls} pulls` : "", entry.tagCount ? `${entry.tagCount} tag${entry.tagCount === 1 ? "" : "s"}` : "", entry.updated ? `updated ${entry.updated}` : ""].filter(Boolean).join(" · "),
      group: entry.cloud ? "Ollama Library · cloud" : "Ollama Library",
      capabilities: caps,
      description: entry.description,
      pulls: entry.pulls,
      updated: entry.updated,
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function providerFamilyForSelection(selection: ProviderSelection): string {
  if (selection.family) return selection.family;
  const fromSource = selection.source.split(":").at(-1);
  if (fromSource && TERMINAL_PROVIDERS.includes(fromSource as TerminalProviderId)) {
    return fromSource;
  }
  const name = selection.provider.name.toLowerCase();
  if (name.startsWith("moa")) return "moa";
  if (name.startsWith("ollama")) return "ollama";
  if (name.startsWith("mock")) return "mock";
  return name;
}

/** Validate a newly requested provider/model without sending conversation data.
 * Selection is only committed after this succeeds, so a typo, expired key, or
 * unpulled Ollama model cannot mutate the session and trigger surprise routing. */
export async function preflightProviderSelection(selection: ProviderSelection): Promise<void> {
  if (!selection.preflight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${selection.family ?? "provider"} preflight timed out after 8 seconds`)), 8_000);
  });
  const result = await Promise.race([selection.preflight(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (!result.ok) throw new Error(result.error);
}

/** Resolve a MoA ensemble's members into concrete Providers by re-entering
 *  selectProvider per member, then build the synthetic MoaProvider. */
async function buildMoaProvider(ensembleName: string): Promise<MoaProvider> {
  const spec = MOA_ENSEMBLES[ensembleName] ?? MOA_ENSEMBLES["moa-council"];
  const resolve = async (m: { provider: string; model: string; label?: string }): Promise<MoaMember> => {
    const sel = await selectProvider(new Map([["provider", m.provider], ["model", m.model]]));
    return { provider: sel.provider, model: sel.model, label: m.label ?? m.model };
  };
  const references = await Promise.all(spec.references.map(resolve));
  const aggregator = await resolve(spec.aggregator);
  return new MoaProvider({ ensembleName, references, aggregator });
}

export async function selectProvider(flags: Map<string, string>): Promise<ProviderSelection> {
  const explicit = flags.get("provider");
  const requestedModel = flags.get("model");
  const auth = await loadAuthToken();
  const settings = await loadUiSettings();
  const preferred = explicit ?? settings.lastProvider;

  if (preferred === "mock") {
    return {
      provider: new MockEchoProvider(),
      model: requestedModel ?? "mock-echo",
      source: "explicit:mock",
      family: "mock",
    };
  }

  if (preferred === "openai" || (!preferred && auth)) {
    const provider = new OpenAIResponsesProvider();
    return {
      provider,
      model: requestedModel ?? process.env.ARES_OPENAI_MODEL ?? settings.lastOpenAIModel ?? "gpt-5.5",
      source: explicit ? "explicit:openai" : preferred ? "settings:openai" : "auto:openai",
      family: "openai",
    };
  }

  if (preferred === "openrouter") {
    const model = requestedModel ?? settings.lastOpenRouterModel ?? "openai/gpt-4o-mini";
    return {
      // Empty key → the provider yields a clear no_auth error the UI surfaces.
      provider: new OpenRouterProvider({ apiKey: settings.openRouterKey ?? "", model }),
      model,
      source: explicit ? "explicit:openrouter" : "settings:openrouter",
      family: "openrouter",
    };
  }

  if (preferred === "custom") {
    // Universal OpenAI-compatible provider: the owner points Ares at ANY base URL
    // (Together, Groq, Fireworks, a self-hosted vLLM, LM Studio, a gateway…) plus
    // a key, and model discovery hits {base}/models. Reuses the OpenAI-compatible
    // OpenRouter client — same /chat/completions wire shape. Empty key/url yields
    // a clear no_auth error the UI surfaces. baseUrl should end at the API root
    // (…/v1); the trailing slash is stripped so paths don't double up.
    const model = requestedModel ?? settings.lastCustomModel ?? "";
    const baseUrl = (settings.customBaseUrl || process.env.ARES_CUSTOM_BASE_URL || "").trim().replace(/\/+$/, "");
    return {
      provider: new OpenRouterProvider({
        apiKey: settings.customApiKey || process.env.ARES_CUSTOM_API_KEY || "",
        baseUrl: baseUrl || undefined,
        model,
      }),
      model,
      source: explicit ? "explicit:custom" : "settings:custom",
      family: "custom",
    };
  }

  if (preferred === "ares") {
    // The Ares Gateway (the owner's accounts site) speaks the Anthropic wire
    // and takes the account bearer token as x-api-key — the hardened
    // AnthropicProvider needs no changes. The GATEWAY resolves the virtual
    // model id ("ares-internal") to a real provider+key server-side.
    const model = requestedModel ?? settings.lastAresModel ?? "ares-internal";
    return {
      provider: new AnthropicProvider({
        apiKey: settings.aresGatewayToken || process.env.ARES_GATEWAY_TOKEN || undefined,
        endpointUrl: `${aresGatewayBase(settings)}/api/gateway/v1/messages`,
      }),
      model,
      source: explicit ? "explicit:ares" : "settings:ares",
      family: "ares",
    };
  }

  if (preferred === "deepseek") {
    const model = requestedModel ?? settings.lastDeepSeekModel ?? "deepseek-v4-pro";
    // Default: DeepSeek's Anthropic-compatible endpoint via the hardened
    // AnthropicProvider — proper thinking<->tool interleaving, unsigned-reasoning
    // echo on tool loops (DeepSeek 400s otherwise), no wasted cache_control /
    // budget_tokens. x-api-key skips the OAuth identity branch (no Claude-Code
    // leak). ARES_DEEPSEEK_DIALECT=openai forces the legacy OpenAI-compat path.
    const useOpenAiDialect = process.env.ARES_DEEPSEEK_DIALECT === "openai";
    const deepSeekKey = settings.deepSeekKey || process.env.DEEPSEEK_API_KEY || "";
    return {
      provider: useOpenAiDialect
        ? new DeepSeekProvider({ apiKey: deepSeekKey, model })
        : new AnthropicProvider({
            apiKey: deepSeekKey || undefined,
            // /anthropic is the base; the Messages API path appends like Anthropic's own.
            endpointUrl: "https://api.deepseek.com/anthropic/v1/messages",
            dialect: "deepseek",
          }),
      model,
      source: explicit ? "explicit:deepseek" : "settings:deepseek",
      family: "deepseek",
      preflight: async () => {
        if (!deepSeekKey) return { ok: false, error: "DeepSeek API key is missing. Add it in Settings → API Keys." };
        try {
          const models = await fetchDeepSeekModels({ apiKey: deepSeekKey });
          if (!models.some((item) => item.id === model)) {
            return { ok: false, error: `DeepSeek model \"${model}\" is not enabled for this API key.` };
          }
          return { ok: true };
        } catch (err) {
          return { ok: false, error: `DeepSeek connection failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    };
  }
  if (preferred === "kimi") {
    const model = requestedModel ?? settings.lastKimiModel ?? "kimi-for-coding";
    // Kimi's coding endpoint is plain Chat Completions with Bearer auth, so the
    // hardened OpenAI-compat client drives it directly. Credential order: the
    // Ares-stored key, the env key, then the subscription token minted by the
    // Kimi OAuth sign-in (owned by the embedded Vanguard module's store).
    let kimiCredential = settings.kimiKey || process.env.KIMI_API_KEY || "";
    if (!kimiCredential) {
      try {
        const vanguard = await import("vanguard") as { resolveKimiAccessToken: () => Promise<string | null> };
        kimiCredential = (await vanguard.resolveKimiAccessToken()) ?? "";
      } catch {
        // vanguard module unavailable — the empty key surfaces as no_auth
      }
    }
    return {
      provider: new OpenRouterProvider({
        apiKey: kimiCredential,
        model,
        baseUrl: "https://api.kimi.com/coding/v1",
        providerName: "kimi",
      }),
      model,
      source: explicit ? "explicit:kimi" : "settings:kimi",
      family: "kimi",
      preflight: async () => {
        if (!kimiCredential) {
          return { ok: false, error: "Kimi is not connected. Sign in with Kimi in Settings → API Keys, or add a Kimi API key." };
        }
        return { ok: true };
      },
    };
  }

  if (preferred === "anthropic") {
    const model = requestedModel ?? settings.lastAnthropicModel ?? DEFAULT_ANTHROPIC_MODEL;
    return {
      // Empty key → AnthropicProvider falls back to ARES_ANTHROPIC_API_KEY /
      // ANTHROPIC_API_KEY, then yields a clear no_auth error the UI surfaces.
      provider: new AnthropicProvider({ apiKey: settings.anthropicKey || undefined }),
      model,
      source: explicit ? "explicit:anthropic" : "settings:anthropic",
      family: "anthropic",
    };
  }

  if (preferred === "moa") {
    // Pick an ensemble like any model; it fans out to references + aggregator.
    const ensembleName = requestedModel ?? settings.lastMoaModel ?? "moa-council";
    return {
      provider: await buildMoaProvider(ensembleName),
      model: ensembleName,
      source: explicit ? "explicit:moa" : "settings:moa",
      family: "moa",
    };
  }

  if (preferred === "ollama" || !preferred) {
    const slots = {
      ...DEFAULT_OLLAMA_SLOTS,
      reasoner: { model: requestedModel ?? settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model },
    };
    const ollamaApiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY;
    // A cloud API key with no explicit OLLAMA_HOST means "use Ollama's CLOUD"
    // (ollama.com) — not the local app. Without this, a user who set only an API
    // key (no local Ollama running) times out hitting 127.0.0.1. An explicit
    // OLLAMA_HOST, or no key at all, keeps the local-app default.
    const ollamaHost =
      process.env.OLLAMA_HOST ?? (ollamaApiKey ? "https://ollama.com" : "http://127.0.0.1:11434");
    const pool = new OllamaCloudPool({
      slots,
      useAnthropicCompat: NATIVE_OLLAMA_OPTS.useAnthropicCompat,
      host: ollamaHost,
      apiKey: ollamaApiKey,
    });
    return {
      provider: pool.provider("reasoner"),
      model: slots.reasoner.model,
      source: explicit ? "explicit:ollama" : preferred ? "settings:ollama" : "auto:ollama",
      family: "ollama",
      preflight: async () => {
        const health = await pool.health();
        if (!health.reachable) {
          return { ok: false, error: `Ollama is not reachable at ${health.host}. Start Ollama or check OLLAMA_HOST.` };
        }
        if (!health.availableModels.includes(slots.reasoner.model)) {
          const available = health.availableModels.slice(0, 6).join(", ");
          return {
            ok: false,
            error: `Ollama model \"${slots.reasoner.model}\" is not installed or available${available ? `. Available now: ${available}` : ""}. Pull it before selecting it.`,
          };
        }
        return { ok: true };
      },
      subModel: {
        apply: (req) => pool.apply(req),
        summarize: (req) => pool.summarize(req),
      },
    };
  }

  throw new Error(`unknown provider: ${preferred}`);
}
