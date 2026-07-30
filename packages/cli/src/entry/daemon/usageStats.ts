// Usage aggregation for the daemon's usage_stats command: scans on-disk
// session event logs and prices tokens via live OpenRouter data.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { fetchOpenRouterModels } from "@ares/core";

export interface UsageStats {
  sessions: number;
  apiCalls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  auxiliaryTokensIn: number;
  auxiliaryTokensOut: number;
  daily: Array<{ date: string; in: number; out: number }>;
  models: Array<{ model: string; provider?: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
  /** Per-provider rollup (tokens, requests, estimated spend) — the DeepSeek-
   *  platform-style view. Cost is an estimate from live OpenRouter pricing
   *  where the model is listed there; undefined = unknown, 0 = local/free. */
  providers: Array<{ provider: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number; costUsd?: number }>;
}

/** Estimate spend for a model from live OpenRouter pricing (matched by id
 *  suffix). Local ollama = $0. Returns undefined when the price is unknown. */
function estimateCostUsd(
  provider: string,
  model: string,
  usage: { tokensIn: number; tokensOut: number; cacheReadTokens: number },
  orPrices: Map<string, { input: number; output: number }>,
): number | undefined {
  if (provider === "ollama" && !model.includes("cloud")) return 0;
  if (provider === "mock") return 0;
  const bare = model.toLowerCase();
  let price = orPrices.get(bare);
  if (!price) {
    for (const [id, p] of orPrices) {
      if (id.endsWith(`/${bare}`) || bare === id.split("/").pop()) {
        price = p;
        break;
      }
    }
  }
  if (!price) return undefined;
  // Cache reads bill at roughly a tenth of input on the major providers.
  const uncachedIn = Math.max(0, usage.tokensIn - usage.cacheReadTokens);
  return (uncachedIn / 1e6) * price.input + (usage.cacheReadTokens / 1e6) * price.input * 0.1 + (usage.tokensOut / 1e6) * price.output;
}

/** Aggregate usage across all on-disk sessions within the trailing window. */
export async function daemonUsageStats(workspace: string, days: number): Promise<UsageStats> {
  const sessionsRoot = path.join(workspace, ".ares", "sessions");
  const cutoff = Date.now() - days * 24 * 60 * 60_000;
  const daily = new Map<string, { in: number; out: number }>();
  const models = new Map<string, { provider: string; model: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number }>();
  const providers = new Map<string, { tokensIn: number; tokensOut: number; cacheReadTokens: number; calls: number }>();
  let sessions = 0;
  let apiCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let auxiliaryTokensIn = 0;
  let auxiliaryTokensOut = 0;
  let dirents: import("node:fs").Dirent[];
  try {
    const { readdir } = await import("node:fs/promises");
    dirents = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return {
      sessions: 0,
      apiCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      auxiliaryTokensIn: 0,
      auxiliaryTokensOut: 0,
      daily: [],
      models: [],
      providers: [],
    };
  }
  const { stat: statFn } = await import("node:fs/promises");
  for (const dir of dirents) {
    if (!dir.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, dir.name);
    const st = await statFn(path.join(sessionDir, "events.jsonl")).catch(() => null);
    if (!st || st.mtimeMs < cutoff) continue;
    const metaRaw = await readFile(path.join(sessionDir, "meta.json"), "utf8").catch(() => "");
    let model = "unknown";
    let sessionProvider = "unknown";
    try {
      const meta = JSON.parse(metaRaw) as { provider?: { model?: string; name?: string } };
      if (meta.provider?.model) model = meta.provider.model;
      if (meta.provider?.name) sessionProvider = meta.provider.name;
    } catch {
      /* unknown model */
    }
    const eventsText = await readFile(path.join(sessionDir, "events.jsonl"), "utf8").catch(() => "");
    if (!eventsText) continue;
    let sIn = 0;
    let sOut = 0;
    let counted = false;
    for (const line of eventsText.split(/\r?\n/)) {
      if (!line) continue;
      let entry: {
        ts?: string | number;
        event?: {
          type?: string;
          model?: string;
          provider?: string;
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            modelCalls?: number;
          };
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = entry.event;
      if ((ev?.type !== "turn_end" && ev?.type !== "auxiliary_usage") || !ev.usage) continue;
      const inTok = ev.usage.inputTokens ?? 0;
      const outTok = ev.usage.outputTokens ?? 0;
      const cached = ev.usage.cacheReadTokens ?? 0;
      const calls = ev.usage.modelCalls ?? 1;
      const eventModel = ev.model || model;
      // Session persistence stamps provider on turn_end/auxiliary_usage — use
      // it for a real per-provider rollup (the old code discarded it).
      const eventProvider = (ev.provider || sessionProvider).toLowerCase();
      apiCalls += calls;
      tokensIn += inTok;
      tokensOut += outTok;
      cacheReadTokens += cached;
      if (ev.type === "auxiliary_usage") {
        auxiliaryTokensIn += inTok;
        auxiliaryTokensOut += outTok;
      }
      sIn += inTok;
      sOut += outTok;
      counted = true;
      const mKey = `${eventProvider} ${eventModel}`;
      const m = models.get(mKey) ?? { provider: eventProvider, model: eventModel, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      m.tokensIn += inTok;
      m.tokensOut += outTok;
      m.cacheReadTokens += cached;
      m.calls += calls;
      models.set(mKey, m);
      const p = providers.get(eventProvider) ?? { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, calls: 0 };
      p.tokensIn += inTok;
      p.tokensOut += outTok;
      p.cacheReadTokens += cached;
      p.calls += calls;
      providers.set(eventProvider, p);
      // Per-entry timestamp beats file mtime: a week-long session no longer
      // dumps all its tokens onto its last-touched day.
      const entryMs = entry.ts ? new Date(entry.ts).getTime() : NaN;
      const day = new Date(Number.isFinite(entryMs) ? entryMs : st.mtimeMs).toISOString().slice(0, 10);
      const d = daily.get(day) ?? { in: 0, out: 0 };
      d.in += inTok;
      d.out += outTok;
      daily.set(day, d);
    }
    if (counted) sessions++;
  }
  // Live OpenRouter pricing turns tokens into estimated dollars where the
  // model is listed there (most frontier + open models are). Cached; a
  // network failure simply leaves cost undefined.
  const orPrices = new Map<string, { input: number; output: number }>();
  const orModels = await fetchOpenRouterModels().catch(() => []);
  for (const m of orModels) {
    if (m.promptPrice == null && m.completionPrice == null) continue;
    orPrices.set(m.id.toLowerCase(), { input: Number(m.promptPrice ?? 0) * 1e6, output: Number(m.completionPrice ?? 0) * 1e6 });
  }
  const dailyArr = [...daily.entries()].map(([date, v]) => ({ date, in: v.in, out: v.out })).sort((a, b) => a.date.localeCompare(b.date));
  const modelArr = [...models.values()]
    .map((v) => ({ ...v, costUsd: estimateCostUsd(v.provider, v.model, v, orPrices) }))
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  const providerArr = [...providers.entries()]
    .map(([provider, v]) => {
      const providerModels = modelArr.filter((m) => m.provider === provider);
      const known = providerModels.filter((m) => m.costUsd !== undefined);
      // A provider's cost is only meaningful if every model under it priced.
      const costUsd = known.length === providerModels.length && providerModels.length > 0
        ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
        : known.length > 0
          ? known.reduce((total, m) => total + (m.costUsd ?? 0), 0)
          : undefined;
      return { provider, ...v, costUsd };
    })
    .sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  return {
    sessions,
    apiCalls,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    auxiliaryTokensIn,
    auxiliaryTokensOut,
    daily: dailyArr,
    models: modelArr,
    providers: providerArr,
  };
}
