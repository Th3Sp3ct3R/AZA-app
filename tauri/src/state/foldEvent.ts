// foldEvent: the per-session transcript reducer (pure, no React), plus the
// tool-kind/label/summary helpers it feeds (extracted from App.tsx).

import type { AresEvent } from "./events";
import {
  nextKey,
  PREVIEWABLE,
  HOLO_SPEC_FILE,
  type SessionVm,
  type Item,
  type ToolStep,
  type FleetAgentVm,
  type CodingBackendVm,
} from "./session";
import { compact, stringify, draftTargetPath } from "../lib/format";

/** Fold one daemon event into the session — pure-ish, works on a draft copy. */
export function foldEvent(s: SessionVm, e: AresEvent): SessionVm {
  const items = [...s.items];
  const last = items[items.length - 1];
  const session = { ...s, items };

  const openAssistant = (): Extract<Item, { kind: "assistant" }> => {
    if (last?.kind === "assistant" && last.streaming) return last;
    const fresh: Extract<Item, { kind: "assistant" }> = {
      kind: "assistant",
      key: nextKey(),
      text: "",
      thinking: "",
      streaming: true,
      model: session.turnModel,
      lane: session.turnLane,
      provider: session.turnProvider,
    };
    items.push(fresh);
    return fresh;
  };

  switch (e.type) {
    case "turn_start":
      session.busy = true;
      session.activity = "marshalling";
      session.fleet = undefined; // clear last turn's fleet board
      session.codingBackend = undefined; // and last turn's delegation cut-scene (fresh elapsed clock)
      break;
    case "consciousness_say": {
      // A proactive remark from the Watch — drop it into the conversation as a
      // finalized assistant bubble (never streaming, never sets busy).
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const text = (e.text ?? "").trim();
      if (text) {
        items.push({
          kind: "assistant",
          key: nextKey(),
          text,
          thinking: "",
          streaming: false,
          proactive: true,
        });
      }
      break;
    }
    case "route_resolved": {
      // The daemon resolved which model+lane handles this turn — attach it so
      // the user can SEE routing working, per message.
      session.turnModel = typeof e.model === "string" ? e.model : session.turnModel;
      session.turnLane = typeof e.lane === "string" ? e.lane : session.turnLane;
      session.turnProvider = typeof e.provider === "string" ? e.provider : session.turnProvider;
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, model: session.turnModel, lane: session.turnLane, provider: session.turnProvider };
      }
      break;
    }
    case "text_delta": {
      const a = openAssistant();
      items[items.length - 1] = { ...a, text: a.text + (e.text ?? "") };
      session.activity = "writing";
      break;
    }
    case "thinking_delta": {
      const a = openAssistant();
      items[items.length - 1] = { ...a, thinking: a.thinking + (e.text ?? "") };
      session.activity = "thinking";
      break;
    }
    case "tool_use_start": {
      // The model just BEGAN authoring this tool call — surface it instantly,
      // before the input finishes streaming. tool_start upgrades this step.
      const step: ToolStep = {
        id: e.id ?? nextKey(),
        label: `${e.name ?? "tool"} · drafting…`,
        name: e.name ?? "tool",
        status: "drafting",
        draftChars: 0,
        draftHead: "",
      };
      session.activity = `drafting ${e.name ?? "tool"}`;
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const tail = items[items.length - 1];
      if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step], finishedAt: undefined };
      else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      break;
    }
    case "tool_use_input_delta": {
      // Live authorship progress: byte counter + early file_path so a big
      // Write shows itself materializing instead of seconds of dead air.
      const delta = typeof e.deltaJson === "string" ? e.deltaJson : "";
      if (!delta) break;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id && st.status === "drafting");
        if (idx !== -1) {
          const steps = [...it.steps];
          const prev = steps[idx];
          const draftChars = (prev.draftChars ?? 0) + delta.length;
          const draftHead = (prev.draftHead ?? "").length < 2048 ? (prev.draftHead ?? "") + delta : prev.draftHead ?? "";
          const target = draftTargetPath(draftHead);
          const size = draftChars >= 1024 ? `${(draftChars / 1024).toFixed(1)}KB` : `${draftChars}ch`;
          const label = target
            ? `${prev.name} · ${target} — writing ${size}`
            : `${prev.name} · drafting ${size}`;
          steps[idx] = { ...prev, draftChars, draftHead, label };
          items[i] = { ...it, steps };
          session.activity = label;
        }
        break;
      }
      break;
    }
    case "tool_start": {
      const step: ToolStep = {
        id: e.id ?? nextKey(),
        label: e.activityDescription ?? toolStartLabel(e.name ?? "tool", e.input),
        name: e.name ?? "tool",
        status: "running",
        inputJson: e.input !== undefined ? compact(stringify(e.input), 1200) : undefined,
      };
      session.activity = step.label;
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      // Upgrade the drafting skeleton for this id if one exists (the input
      // finished streaming and the tool is now actually executing).
      let upgraded = false;
      for (let i = items.length - 1; i >= 0 && !upgraded; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === step.id);
        if (idx !== -1) {
          const steps = [...it.steps];
          steps[idx] = step;
          items[i] = { ...it, steps, finishedAt: undefined };
          upgraded = true;
        }
        break;
      }
      if (!upgraded) {
        const tail = items[items.length - 1];
        if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step], finishedAt: undefined };
        else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      }
      break;
    }
    case "tool_progress": {
      // Live sub-tool output — shell stdout/stderr stream, grep tick counts,
      // subagent activity. Previously produced + transported, then dropped here,
      // so a 5-minute build looked frozen. Append shell output to the matching
      // step's bounded live tail; surface grep/subagent ticks as the step label.
      const d = e.data;
      if (!d) break;
      // Conductor fleet board — one row per leaf agent, grouped by phase.
      if (d.kind === "fleet_activity" && d.event === "fleet_start") {
        session.fleet = { active: true, fleetId: d.fleetId, agents: session.fleet?.agents ?? [] };
        break;
      }
      if (d.kind === "fleet_activity" && typeof d.agentId === "string") {
        const agents = [...(session.fleet?.agents ?? [])];
        const at = agents.findIndex((a) => a.id === d.agentId);
        const ev = d.event as string | undefined;
        const resolved: FleetAgentVm["status"] =
          ev === "done" ? (d.status === "completed" ? "done" : "failed") : ev === "resumed" ? "done" : "running";
        const base = at === -1
          ? { id: d.agentId, role: String(d.role ?? "agent"), phase: String(d.phase ?? ""), status: "running" as FleetAgentVm["status"], tool: undefined as string | undefined, activity: undefined as string | undefined, resumed: false }
          : agents[at];
        const next = {
          ...base,
          status: ev === "tool" ? base.status : resolved,
          tool: typeof d.tool === "string" ? d.tool : base.tool,
          activity: typeof d.activity === "string" ? d.activity : base.activity,
          resumed: ev === "resumed" ? true : base.resumed,
        };
        if (at === -1) agents.push(next);
        else agents[at] = next;
        session.fleet = { ...session.fleet, active: true, agents };
        break;
      }
      // Delegation cut-scene — Ares handing a job to Claude Code / Codex on the
      // Ares account. These events already flowed here but were dropped; now they
      // drive the animated scene.
      if (d.kind === "coding_backend") {
        const prev = session.codingBackend;
        const phase = (typeof d.phase === "string" ? d.phase : prev?.phase ?? "detect") as CodingBackendVm["phase"];
        const line = typeof d.line === "string" ? d.line.trim() : "";
        const lines = line ? [...(prev?.lines ?? []), line].slice(-6) : prev?.lines ?? [];
        // Count edited files live from Claude Code's stream-json tool_use blocks.
        let filesTouched = typeof d.filesTouched === "number" ? d.filesTouched : prev?.filesTouched ?? 0;
        if (line && /"type"\s*:\s*"tool_use"/.test(line) && /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit|Update)"/.test(line)) {
          filesTouched = (prev?.filesTouched ?? 0) + 1;
        }
        session.codingBackend = {
          backend: typeof d.backend === "string" ? d.backend : prev?.backend ?? "claude",
          label: typeof d.label === "string" ? d.label : prev?.label ?? "Claude Code",
          phase,
          lines,
          filesTouched,
          startedTick: prev?.startedTick ?? Date.now(),
        };
        break;
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id);
        if (idx === -1) continue;
        const steps = [...it.steps];
        const step = { ...steps[idx] };
        if (d.kind === "shell_output" && typeof d.text === "string") {
          const tail = (step.liveTail ?? "") + d.text;
          const lines = tail.split("\n");
          step.liveTail = lines.length > 200 ? lines.slice(-200).join("\n") : tail;
        } else if (d.kind === "grep_match" && typeof d.total === "number") {
          step.detail = `${d.total} match${d.total === 1 ? "" : "es"}…`;
        } else if (d.kind === "subagent_activity" && typeof d.activity === "string") {
          step.detail = d.activity;
        }
        steps[idx] = step;
        items[i] = { ...it, steps };
        break;
      }
      break;
    }
    case "tool_end":
    case "tool_error": {
      if (e.type === "tool_end") {
        for (const f of e.touchedFiles ?? []) {
          if ((PREVIEWABLE.test(f) || HOLO_SPEC_FILE.test(f)) && !items.some((it) => it.kind === "artifact" && it.path === f)) {
            items.push({ kind: "artifact", key: nextKey(), path: f, label: f.split(/[\\/]/).pop() ?? f });
          }
        }
      }
      let matched = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== "tools") continue;
        const idx = it.steps.findIndex((st) => st.id === e.id);
        if (idx === -1) continue;
        const steps = [...it.steps];
        steps[idx] = {
          ...steps[idx],
          status: e.type === "tool_end" ? "ok" : "error",
          durationMs: e.durationMs,
          detail: e.type === "tool_end" ? compact(e.display ?? stringify(e.output), 1600) : compact(String(e.error ?? "failed"), 1600),
        };
        items[i] = {
          ...it,
          steps,
          finishedAt: steps.every((step) => step.status !== "running" && step.status !== "drafting") ? Date.now() : it.finishedAt,
        };
        matched = true;
        break;
      }
      // Orphan tool_error (e.g. the model called a tool that doesn't exist —
      // no tool_start ever fired). Surface it: an invisible failure reads as
      // "the agent is doing nothing" when it's actually erroring.
      if (!matched && e.type === "tool_error") {
        const step: ToolStep = {
          id: e.id ?? nextKey(),
          label: "unrecognized tool call",
          name: "tool",
          status: "error",
          durationMs: e.durationMs,
          detail: compact(String(e.error ?? "failed"), 1600),
        };
        const tail = items[items.length - 1];
        if (tail?.kind === "tools") items[items.length - 1] = { ...tail, steps: [...tail.steps, step] };
        else items.push({ kind: "tools", key: nextKey(), steps: [step], startedAt: Date.now() });
      }
      break;
    }
    case "permission_request":
      items.push({ kind: "permission", key: nextKey(), id: e.id ?? "", toolName: e.toolName ?? "tool", reason: e.reason ?? "" });
      break;
    case "permission_response": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id) {
          items[i] = { ...it, decided: e.decision ?? "decided" };
          break;
        }
      }
      break;
    }
    case "system_reminder_injected": {
      // Injected reminders are model plumbing, not chat. Surface only the small
      // operational allowlist that needs owner attention; durable state,
      // repository maps, verifier output and loop guards stay in diagnostics.
      const text = e.text ?? "";
      const visible = /^(?:Provider failed|All configured providers failed|Your Ares account couldn't run|Image attached|Garrison is down)|retrying with a smaller recent-history window/i.test(text);
      if (!visible) break;
      const tone = /failed|couldn't run|down/i.test(text) ? "warn" : "dim";
      items.push({ kind: "notice", key: nextKey(), text: compact(text, 400), tone });
      break;
    }
    case "compaction": {
      const before = typeof e.tokensBefore === "number" ? e.tokensBefore : 0;
      const after = typeof e.tokensAfter === "number" ? e.tokensAfter : 0;
      const n = typeof e.summarizedMessages === "number" ? e.summarizedMessages : 0;
      const how = e.method === "ledger" ? "digest" : "summary";
      const k = (t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`);
      session.activity = "compacting memory";
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `Compacted ${n} older message${n === 1 ? "" : "s"} into a ${how} · ${k(before)}→${k(after)} tokens`,
        tone: "dim",
      });
      break;
    }
    case "todo_updated":
      session.todos = (e.todos ?? []).map((t, i) => ({
        id: t.id ?? `t${i}`,
        content: t.content ?? "",
        activeForm: t.activeForm ?? t.content ?? "",
        status: t.status ?? "pending",
      }));
      {
        const current = session.todos.find((t) => t.status === "in_progress");
        if (current) session.activity = current.activeForm || current.content;
      }
      break;
    case "workspace_diff":
      if (e.diff && e.diff.trim()) {
        items.push({ kind: "diff", key: nextKey(), files: e.files ?? [], diff: compact(e.diff, 12_000), truncated: e.truncated ?? false });
      }
      break;
    case "undo_result":
      items.push({ kind: "notice", key: nextKey(), text: e.text ?? "Workspace restored.", tone: "warn" });
      break;
    case "subagent_start":
      items.push({ kind: "subagent", key: nextKey(), id: e.id ?? nextKey(), name: e.name ?? "worker", description: e.description ?? "", status: "running" });
      session.activity = `worker · ${e.description ?? e.name ?? "spawned"}`;
      break;
    case "subagent_end": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "subagent" && it.id === e.id) {
          items[i] = { ...it, status: (e.status as "completed" | "failed" | "cancelled") ?? "completed", summary: compact(e.summary ?? "", 600) };
          break;
        }
      }
      break;
    }
    case "turn_end": {
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, streaming: false };
      const input = e.usage?.inputTokens ?? 0;
      const output = e.usage?.outputTokens ?? 0;
      items.push({
        kind: "usage",
        key: nextKey(),
        input,
        output,
        cacheRead: e.usage?.cacheReadTokens ?? 0,
        modelCalls: e.usage?.modelCalls ?? 1,
        durationMs: e.durationMs ?? 0,
        status: e.status ?? "completed",
        model: session.turnModel,
        lane: session.turnLane,
        provider: session.turnProvider,
      });
      session.busy = false;
      session.steerQueued = 0;
      session.tokensIn += input;
      session.cacheReadTokens += e.usage?.cacheReadTokens ?? 0;
      session.tokensOut += output;
      if (session.fleet) {
        // If any leaf failed/aborted (or never finished), keep the board up with a
        // resume affordance instead of hiding it. Otherwise hide on completion.
        const incomplete = session.fleet.agents.some((a) => a.status === "failed" || a.status === "running");
        session.fleet = { ...session.fleet, active: false, canResume: incomplete && !!session.fleet.fleetId };
      }
      break;
    }
    case "steer_applied": {
      // The daemon folded a queued steer into the live turn — mark it landed.
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "steer" && !(items[i] as Extract<Item, { kind: "steer" }>).landed) {
          items[i] = { ...(items[i] as Extract<Item, { kind: "steer" }>), landed: true };
          break;
        }
      }
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      session.activity = "steering";
      break;
    }
    case "steer_queued":
      session.activity = "steer queued";
      break;
    case "daemon_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(stringify(e.error ?? "daemon error"), 500), tone: "bad" });
      break;
    case "error": {
      const errObj = e.error as { code?: string; message?: string } | undefined;
      const msg = errObj?.message ?? (typeof e.error === "string" ? e.error : e.text ?? "error");
      // Missing Anthropic auth → an actionable in-chat sign-in prompt, not a dead error.
      if (errObj?.code === "no_auth" && /anthropic|claude/i.test(msg)) {
        items.push({ kind: "authPrompt", key: nextKey(), provider: "anthropic", text: msg });
      } else {
        items.push({ kind: "notice", key: nextKey(), text: compact(msg, 500), tone: "bad" });
      }
      session.busy = false;
      break;
    }
    case "desktop_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(e.text ?? "desktop error", 500), tone: "bad" });
      break;
    default:
      break;
  }
  return session;
}

/** Coarse action family for a tool — drives the verb, the glyph, and the
 *  human roll-up summary. Keep in sync with toolGlyph (which folds create→edit
 *  for the icon, but the summary wants them split). */
export type ToolKind = "read" | "search" | "edit" | "create" | "shell" | "web" | "task" | "other";
export function toolKind(name: string): ToolKind {
  if (/^(Write)$/i.test(name)) return "create";
  if (/^(Edit|ApplyIntent|FindAndEdit|NotebookEdit|MultiEdit)$/i.test(name)) return "edit";
  if (/^(Read|Glob|NotebookRead|LS)$/i.test(name)) return "read";
  if (/^(Grep|CodebaseSearch|WebSearch|Search)$/i.test(name)) return "search";
  if (/^(Bash|PowerShell|BashOutput|KillShell|Shell)$/i.test(name)) return "shell";
  if (/^(WebFetch|Browser|Fetch)/i.test(name)) return "web";
  if (/^(Task|Operator|Agent)$/i.test(name)) return "task";
  return "other";
}

/** Present-tense verb for an in-flight call — "Editing", "Creating", "Running". */
export function toolVerb(name: string): string {
  switch (toolKind(name)) {
    case "create": return "Creating";
    case "edit": return "Editing";
    case "read": return "Reading";
    case "search": return /websearch/i.test(name) ? "Searching the web for" : "Searching";
    case "shell": return "Running";
    case "web": return "Fetching";
    case "task": return "Delegating";
    default: return name;
  }
}

/** Human, verb-first label for a tool call from its name + input —
 *  "Creating ares-fact.html", "Searching validateSession", "Running npm test".
 *  The daemon doesn't always send an activityDescription, and a bare tool name
 *  ("tools ran") tells the user nothing about what's actually happening. */
export function toolStartLabel(name: string, input: unknown): string {
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const firstString = (...keys: string[]) => {
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const verb = toolVerb(name);
  const path = firstString("file_path", "path", "notebook_path");
  const target = path || firstString("pattern", "query", "url", "command", "description", "goal");
  if (!target) return verb === name ? name : `${verb}…`;
  // For paths, show the last 1–2 segments; for everything else, a clipped phrase.
  const segs = target.split(/[\\/]/).filter(Boolean);
  const compactTarget = path && segs.length > 2 ? segs.slice(-2).join("/") : target;
  const short = compactTarget.length > 64 ? `${compactTarget.slice(0, 64)}…` : compactTarget;
  return verb === name ? `${name} · ${short}` : `${verb} ${short}`;
}

/** A transparent one-line roll-up of a finished tool group — "Read 3 files ·
 *  edited 2 · ran 1 command" instead of the opaque "6 actions · 6 done". */
export function summarizeSteps(steps: ToolStep[]): string {
  const counts: Record<ToolKind, number> = { read: 0, search: 0, edit: 0, create: 0, shell: 0, web: 0, task: 0, other: 0 };
  for (const s of steps) counts[toolKind(s.name)]++;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (counts.create) parts.push(`created ${plural(counts.create, "file", "files")}`);
  if (counts.edit) parts.push(`edited ${plural(counts.edit, "file", "files")}`);
  if (counts.read) parts.push(`read ${plural(counts.read, "file", "files")}`);
  if (counts.search) parts.push(`${plural(counts.search, "search", "searches")}`);
  if (counts.shell) parts.push(`ran ${plural(counts.shell, "command", "commands")}`);
  if (counts.web) parts.push(`fetched ${plural(counts.web, "page", "pages")}`);
  if (counts.task) parts.push(`${plural(counts.task, "delegation", "delegations")}`);
  if (counts.other) parts.push(`${plural(counts.other, "action", "actions")}`);
  // Capitalize the first word so it reads like a sentence fragment.
  const joined = parts.join(" · ");
  return joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : `${steps.length} actions`;
}
