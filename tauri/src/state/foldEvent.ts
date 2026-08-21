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

  const steerIndex = (inputId?: string): number => {
    if (inputId) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "steer" && (items[i] as Extract<Item, { kind: "steer" }>).inputId === inputId) return i;
      }
      return -1;
    }
    // Legacy fallback only. If an ID was supplied, never settle a different
    // correction merely because its bubble happens to be newest.
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "steer" && !(items[i] as Extract<Item, { kind: "steer" }>).landed) return i;
    }
    return -1;
  };

  const updateSteer = (inputId: string | undefined, patch: Partial<Extract<Item, { kind: "steer" }>>): number => {
    const index = steerIndex(inputId);
    if (index >= 0) items[index] = { ...(items[index] as Extract<Item, { kind: "steer" }>), ...patch };
    return index;
  };

  const restoreSteerDraft = (inputId: string | undefined, status: "cancelled" | "rejected"): boolean => {
    const index = updateSteer(inputId, { status, landed: false });
    if (index < 0) return false;
    const steer = items[index] as Extract<Item, { kind: "steer" }>;
    if (!steer.inputId) return false;
    const queued = session.recoverableDrafts ?? [];
    if (!queued.some((draft) => draft.inputId === steer.inputId)) {
      session.recoverableDrafts = [...queued, {
        inputId: steer.inputId,
        text: steer.text,
        ...(steer.images?.length ? { images: [...steer.images] } : {}),
      }];
    }
    return true;
  };

  const rollbackProviderAttempt = (
    attemptId: string,
    boundary: number,
    options: { removeAssistant: boolean; toolUseIds?: ReadonlySet<string> },
  ): void => {
    for (let i = items.length - 1; i >= boundary; i--) {
      const item = items[i];
      if (options.removeAssistant && item.kind === "assistant" && item.providerAttemptId === attemptId) {
        items.splice(i, 1);
        continue;
      }
      if (item.kind !== "tools") continue;
      const steps = item.steps.filter((step) => {
        if (step.providerAttemptId !== attemptId || step.actuallyStarted === true) return true;
        return options.toolUseIds ? !options.toolUseIds.has(step.id) : false;
      });
      if (steps.length === 0) items.splice(i, 1);
      else if (steps.length !== item.steps.length) items[i] = { ...item, steps };
    }
  };

  const openAssistant = (): Extract<Item, { kind: "assistant" }> => {
    if (
      last?.kind === "assistant" &&
      last.streaming &&
      last.providerAttemptId === session.providerAttempt?.id
    ) return last;
    const fresh: Extract<Item, { kind: "assistant" }> = {
      kind: "assistant",
      key: nextKey(),
      text: "",
      thinking: "",
      streaming: true,
      model: session.turnModel,
      lane: session.turnLane,
      provider: session.turnProvider,
      providerAttemptId: session.providerAttempt?.id,
    };
    items.push(fresh);
    return fresh;
  };

  switch (e.type) {
    case "turn_start": {
      session.busy = true;
      session.cancelling = false;
      session.activity = "marshalling";
      session.authFailedTurn = undefined;
      // Clear last turn's fleet board — UNLESS it can still resume or has
      // agents still running (background fleets survive turn boundaries; a new
      // turn must not make live background work invisible).
      const fleet = session.fleet;
      const keepFleet = !!fleet && (fleet.canResume === true || fleet.agents.some((a) => a.status === "running"));
      if (!keepFleet) session.fleet = undefined;
      session.codingBackend = undefined; // and last turn's delegation cut-scene (fresh elapsed clock)
      break;
    }
    case "startup_recovery_preparing":
      // The daemon has claimed visible ownership of this exact durable input,
      // even though it may still be waiting for a crashed lease to expire.
      // Keep the composer in steer/Stop mode throughout that takeover window.
      session.busy = true;
      session.cancelling = false;
      session.activity = "recovering interrupted work";
      break;
    case "startup_recovery_queued":
      // Lease takeover is complete, but ordinary turn_start has not necessarily
      // arrived yet. Do not briefly unlock the composer in that hand-off gap.
      session.busy = true;
      session.cancelling = false;
      session.activity = "resuming recovered work";
      break;
    case "startup_recovery_failed":
      session.busy = false;
      session.cancelling = false;
      session.activity = undefined;
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `Ares could not safely resume the interrupted turn${e.error ? `: ${compact(stringify(e.error), 300)}` : "."} The request remains durable; restart Ares to retry it.`,
        tone: "warn",
      });
      break;
    case "provider_attempt_started": {
      if (!e.attemptId) break;
      const prior = session.providerAttempt;
      if (prior && prior.id !== e.attemptId) {
        // Provider retries do not always have an explicit superseded event.
        // A new attempt is itself the fence for uncommitted prior output.
        rollbackProviderAttempt(prior.id, prior.itemBoundary, { removeAssistant: true });
      }
      if (prior?.id === e.attemptId) {
        session.activity = (session.steerQueued ?? 0) > 0 ? "responding to steer" : "generating";
        break;
      }
      session.providerAttempt = { id: e.attemptId, itemBoundary: items.length };
      session.activity = (session.steerQueued ?? 0) > 0 ? "responding to steer" : "generating";
      break;
    }
    case "provider_attempt_superseded": {
      const attemptId = e.attemptId;
      const activeAttempt = session.providerAttempt;
      const boundary = activeAttempt && activeAttempt.id === attemptId
        ? activeAttempt.itemBoundary
        : 0;
      if (attemptId) {
        // Preserve owner-authored steer bubbles and settled tools. Remove only
        // transient output attributed to the superseded provider attempt.
        rollbackProviderAttempt(attemptId, boundary, { removeAssistant: true });
      }
      if (session.providerAttempt?.id === attemptId) session.providerAttempt = undefined;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "steer" && item.status === "interrupting_generation") {
          items[i] = { ...item, status: "waiting_for_boundary" };
        }
      }
      session.activity = e.reason === "steering" ? "applying steer" : "restarting generation";
      break;
    }
    case "provider_attempt_effects_skipped": {
      const attemptId = e.attemptId;
      if (!attemptId) break;
      const toolUseIds = new Set(e.toolUseIds ?? []);
      // message_done already committed the assistant. Steering at this edge
      // cancels only proposed effects that never crossed tool_start. Preserve
      // their explicit error settlement so live UI and history reload agree.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== "tools") continue;
        const steps = item.steps.map((step) => (
          step.providerAttemptId === attemptId &&
          toolUseIds.has(step.id) &&
          step.actuallyStarted !== true
            ? {
                ...step,
                status: "error" as const,
                label: `${step.name} · skipped by steer`,
                detail: step.detail ?? "Skipped before execution because a newer owner correction arrived.",
              }
            : step
        ));
        items[i] = { ...item, steps, finishedAt: item.finishedAt ?? Date.now() };
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.kind === "assistant" && item.providerAttemptId === attemptId) {
          if (item.streaming) items[i] = { ...item, streaming: false };
          break;
        }
      }
      if (session.providerAttempt?.id === attemptId) session.providerAttempt = undefined;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "steer" && item.status === "interrupting_generation") {
          items[i] = { ...item, status: "waiting_for_boundary" };
        }
      }
      session.activity = "applying steer";
      break;
    }
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
      // No lane on the event = manual routing (no router ran). Clear rather
      // than keep a stale lane from an earlier auto-routed turn.
      session.turnLane = typeof e.lane === "string" ? e.lane : undefined;
      session.turnProvider = typeof e.provider === "string" ? e.provider : session.turnProvider;
      // "assigned" covers one-turn detours (vision escalation, failover, lane
      // routing) — those must not overwrite the card's pinned selection.
      if (typeof e.model === "string" && e.source !== "assigned") {
        session.sessionModel = e.model;
      }
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
    case "message_done": {
      const attemptId = session.providerAttempt?.id;
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (
          item.kind === "assistant" &&
          item.streaming &&
          (attemptId ? item.providerAttemptId === attemptId : true)
        ) {
          items[i] = { ...item, streaming: false };
          break;
        }
      }
      session.providerAttempt = undefined;
      session.activity = e.stopReason === "tool_use" ? "settling proposed actions" : "response committed";
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
        providerAttemptId: session.providerAttempt?.id,
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
        providerAttemptId: session.providerAttempt?.id,
        actuallyStarted: true,
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
          steps[idx] = { ...step, providerAttemptId: it.steps[idx].providerAttemptId ?? step.providerAttemptId };
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
        // A new fleet REPLACES the board (fresh run, fresh rows) — carrying the
        // previous run's agents forward painted ghosts over a new fleet.
        session.fleet = {
          active: true,
          fleetId: d.fleetId,
          goal: typeof d.goal === "string" ? d.goal : undefined,
          agents: [],
        };
        break;
      }
      // Phase lifecycle — folds into per-phase status, never into agent rows
      // (the phase pseudo-agentId "phase:<id>" must not render as a worker).
      if (d.kind === "fleet_activity" && (d.event === "phase_start" || d.event === "phase_end")) {
        const phaseId = typeof d.phase === "string" && d.phase
          ? d.phase
          : typeof d.agentId === "string"
            ? d.agentId.replace(/^phase:/, "")
            : "";
        if (phaseId) {
          const phases = { ...(session.fleet?.phases ?? {}) };
          const prev = phases[phaseId] ?? {};
          const deliverables = d.contract?.deliverables;
          phases[phaseId] = {
            kind: typeof d.phaseKind === "string" ? d.phaseKind : prev.kind,
            build: typeof d.build === "boolean" ? d.build : prev.build,
            status: d.event === "phase_start"
              ? "running"
              : typeof d.status === "string" && d.status
                ? d.status
                : "completed",
            failureReason: typeof d.failureReason === "string" ? d.failureReason : prev.failureReason,
            deliverables: Array.isArray(deliverables) ? deliverables : prev.deliverables,
          };
          session.fleet = {
            ...session.fleet,
            active: true,
            agents: session.fleet?.agents ?? [],
            phases,
          };
        }
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
        session.lastCodingBackend = {
          backend: session.codingBackend.backend,
          label: session.codingBackend.label,
          phase: session.codingBackend.phase,
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
        const completedToolName = steps[idx].name;
        steps[idx] = {
          ...steps[idx],
          status: e.type === "tool_end" ? "ok" : "error",
          durationMs: e.durationMs,
          detail: e.type === "tool_end" ? compact(e.display ?? stringify(e.output), 1600) : compact(String(e.error ?? "failed"), 1600),
        };
        if (e.type === "tool_end" && (completedToolName === "EnterPlanMode" || completedToolName === "ExitPlanMode")) {
          const output = e.output && typeof e.output === "object" && !Array.isArray(e.output)
            ? e.output as Record<string, unknown>
            : {};
          const nextMode = output.mode === "plan" ? "plan" : output.mode === "workspace-write" ? "build" : undefined;
          if (nextMode && session.workflowMode !== nextMode) {
            session.workflowMode = nextMode;
            items.push({
              kind: "notice",
              key: nextKey(),
              text: nextMode === "plan"
                ? "PLAN MODE — discussion, research, and inspection are available; edits and execution are locked."
                : "BUILD MODE — you approved the exact plan handoff; edits and execution are unlocked.",
              tone: "dim",
            });
          }
        }
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
      if (e.toolName === "ExitPlanMode") session.workflowMode = "plan";
      items.push({ kind: "permission", key: nextKey(), id: e.id ?? "", toolName: e.toolName ?? "tool", reason: e.reason ?? "", input: e.input });
      break;
    case "permission_response": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id) {
          items[i] = { ...it, decided: e.decision ?? "decided", submitting: undefined };
          break;
        }
      }
      break;
    }
    case "permission_submission_started": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id && !it.decided) {
          items[i] = { ...it, submitting: e.decision ?? "decision" };
          break;
        }
      }
      break;
    }
    case "permission_submission_failed": {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "permission" && it.id === e.id && !it.decided) {
          items[i] = { ...it, submitting: undefined };
          break;
        }
      }
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `Ares did not receive that approval response${e.error ? `: ${compact(stringify(e.error), 240)}` : "."} The approval buttons are active again.`,
        tone: "warn",
      });
      break;
    }
    case "system_reminder_injected": {
      // Injected reminders are model plumbing, not chat. Surface only the small
      // operational allowlist that needs owner attention; durable state,
      // repository maps, verifier output and loop guards stay in diagnostics.
      const text = e.text ?? "";
      // Verification-spine disclosures (UNVERIFIED/UNRESOLVED/GUI-UNVERIFIED)
      // are deliberately NOT surfaced here — the owner asked for them gone.
      // They remain in diagnostics and in the model's own context.
      const visible = /^(?:Provider failed|All configured providers failed|Your Ares account couldn't run|Image attached|Garrison is down)|retrying with a smaller recent-history window/i.test(text);
      if (!visible) break;
      const tone = /failed|couldn't run|down/i.test(text) ? "warn" : "dim";
      items.push({ kind: "notice", key: nextKey(), text: compact(text, 400), tone });
      break;
    }
    case "compaction": {
      // Microcompaction is silent storage maintenance. It does not call a
      // summarizer and must not impersonate a long-running activity in chat.
      if (e.method === "micro") break;
      const before = typeof e.tokensBefore === "number" ? e.tokensBefore : 0;
      const after = typeof e.tokensAfter === "number" ? e.tokensAfter : 0;
      const n = typeof e.summarizedMessages === "number" ? e.summarizedMessages : 0;
      const how = e.method === "ledger" ? "digest" : "summary";
      const k = (t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : `${t}`);
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
      // workStatus (unverified/blocked) is intentionally NOT surfaced as a chat
      // notice — the owner removed the warning + Verify-now button. The status
      // still flows to diagnostics via the event stream.
      // An auth-class failure with NO model output ate the user's message for
      // nothing — hand it back to the composer so fixing the key is the only
      // thing standing between them and a resend (no retyping).
      if (e.status === "failed" && session.authFailedTurn) {
        const lastUserIdx = items.reduce((found, it, i) => (it.kind === "user" ? i : found), -1);
        const producedOutput = lastUserIdx >= 0 && items.slice(lastUserIdx + 1).some(
          (it) => (it.kind === "assistant" && it.text.trim().length > 0) || it.kind === "tools",
        );
        const lastUser = lastUserIdx >= 0 ? (items[lastUserIdx] as Extract<Item, { kind: "user" }>) : null;
        if (lastUser?.inputId && !producedOutput && (lastUser.text.trim() || lastUser.images?.length)) {
          const queued = session.recoverableDrafts ?? [];
          if (!queued.some((draft) => draft.inputId === lastUser.inputId)) {
            session.recoverableDrafts = [...queued, {
              inputId: lastUser.inputId,
              text: lastUser.text,
              ...(lastUser.images?.length ? { images: [...lastUser.images] } : {}),
            }];
            items.push({
              kind: "notice",
              key: nextKey(),
              text: "That send failed on authentication before the model saw it — your message is back in the draft. Fix the key or sign-in, then press send.",
              tone: "warn",
            });
          }
        }
      }
      session.authFailedTurn = undefined;
      // QueryEngine's terminal boundary precedes daemon verification/reflection
      // and release of `turnActive`. Keep every composer in steer/Stop mode
      // until the host emits turn_settled; otherwise an immediate fresh message
      // can be admitted as a steer against the dying owner and then lost on Stop.
      session.busy = true;
      session.activity = session.cancelling ? "stopping safely" : "settling turn";
      session.providerAttempt = undefined;
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
    case "turn_settled":
      session.busy = e.continuing === true;
      session.cancelling = false;
      session.activity = e.continuing ? "continuing queued correction" : undefined;
      break;
    case "desktop_pending_input_cancelled": {
      // This ordinary input existed only in Desktop's restart buffer. Remove
      // its exact transcript bubble and hand the clean user-authored payload
      // back to the composer; daemon_ready must have nothing left to replay.
      const index = e.inputId
        ? items.findIndex((item) => item.kind === "user" && item.inputId === e.inputId)
        : -1;
      if (index >= 0) items.splice(index, 1);
      if (e.inputId) {
        const queued = session.recoverableDrafts ?? [];
        if (!queued.some((draft) => draft.inputId === e.inputId)) {
          session.recoverableDrafts = [...queued, {
            inputId: e.inputId,
            text: e.text ?? "",
            ...(e.images?.length ? { images: [...e.images] } : {}),
          }];
        }
      }
      if (!items.some((item) => item.kind === "user")) session.title = "New session";
      session.busy = false;
      session.cancelling = false;
      session.activity = undefined;
      break;
    }
    case "interrupt_requested":
    case "interrupt_pending":
      session.busy = true;
      session.cancelling = true;
      session.activity = "stopping safely";
      break;
    case "interrupt_settled":
    case "interrupted_by_user":
      session.busy = false;
      session.cancelling = false;
      session.steerQueued = 0;
      session.activity = undefined;
      break;
    case "interrupt_forced":
      // Processes were killed, but the turn has NOT settled yet — the daemon
      // guarantees an interrupt_settled within its force-release grace window.
      // Unlocking here invited sends that bounced off "turn_cancelling" for
      // seconds; keep the gate honest (and bounded) until settlement.
      session.busy = true;
      session.cancelling = true;
      session.activity = "force-stopping";
      break;
    case "interrupt_idle":
      // Idempotent Stop raced the real terminal boundary or targeted an idle
      // session. It must not leave an optimistic Desktop gate behind.
      session.busy = false;
      session.cancelling = false;
      session.activity = undefined;
      break;
    case "steer_applied": {
      // The daemon folded a queued steer into the live turn — mark it landed.
      updateSteer(e.inputId, { landed: true, status: "applied" });
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      session.activity = "steer applied";
      break;
    }
    case "steer_submitted":
    case "steer_queued":
      updateSteer(e.inputId, { status: "submitting" });
      session.activity = "sending steer";
      break;
    case "steer_buffered":
      updateSteer(e.inputId, { status: "waiting_for_boundary" });
      session.activity = "waiting for active turn admission";
      break;
    case "steer_admitted":
      if (e.delivery === "interrupting_generation") {
        updateSteer(e.inputId, { status: "interrupting_generation" });
        session.activity = "interrupting generation";
      } else if (e.delivery === "waiting_for_action") {
        updateSteer(e.inputId, { status: "waiting_for_action" });
        session.activity = "waiting for current action to settle";
      } else {
        updateSteer(e.inputId, { status: "waiting_for_boundary" });
        session.activity = "applying steer at next boundary";
      }
      break;
    case "steer_cancelled":
      restoreSteerDraft(e.inputId, "cancelled");
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      session.activity = "steer restored to draft";
      break;
    case "steer_rejected":
      restoreSteerDraft(e.inputId, "rejected");
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      session.activity = "steer restored to draft";
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `Steer was not admitted${e.error ? `: ${compact(stringify(e.error), 300)}` : "."} It was restored to your draft.`,
        tone: "warn",
      });
      break;
    case "steer_settled":
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      break;
    case "input_replayed": {
      if (!e.settled) break;
      const index = steerIndex(e.inputId);
      if (index < 0) break;
      const steer = items[index] as Extract<Item, { kind: "steer" }>;
      if (steer.status === "applied" || steer.status === "cancelled" || steer.status === "rejected") break;
      if (e.status === "cancelled") {
        restoreSteerDraft(e.inputId, "cancelled");
        session.activity = "steer restored to draft";
      } else {
        updateSteer(e.inputId, { landed: true, status: "applied" });
        session.activity = "steer already applied";
      }
      session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
      break;
    }
    case "steer_epilogue_warning":
      if (e.status === "admitted" || e.status === "claimed") {
        updateSteer(e.inputId, { status: "waiting_for_boundary" });
      }
      items.push({
        kind: "notice",
        key: nextKey(),
        text: `The steer remains durably ${e.status ?? "recorded"}; only its follow-up acknowledgement failed${e.error ? `: ${compact(stringify(e.error), 300)}` : "."}`,
        tone: "warn",
      });
      break;
    case "input_rejected":
      if (e.reason === "turn_cancelling" || e.reason === "turn_preparing" || e.reason === "turn_settling") {
        const restored = restoreSteerDraft(e.inputId, "rejected");
        if (restored) session.steerQueued = Math.max(0, (session.steerQueued ?? 0) - 1);
        items.push({
          kind: "notice",
          key: nextKey(),
          text: restored
            ? e.reason === "turn_cancelling"
              ? "That steer arrived while the turn was stopping, so it was restored to your draft. Send it when stopping finishes."
              : e.reason === "turn_preparing"
                ? "Ares was still preparing the turn. Your steer was restored to the draft and can be sent as soon as generation starts."
                : "The model had already ended and the turn was settling. Your steer was restored to the draft for the next turn."
            : "That message was not sent because the previous turn cannot accept steering at this boundary.",
          tone: "warn",
        });
      }
      break;
    case "daemon_error":
      items.push({ kind: "notice", key: nextKey(), text: compact(stringify(e.error ?? "daemon error"), 500), tone: "bad" });
      break;
    case "error": {
      const errObj = e.error as { code?: string; message?: string; retriable?: boolean } | undefined;
      const msg = errObj?.message ?? (typeof e.error === "string" ? e.error : e.text ?? "error");
      const retriable = errObj?.retriable === true;
      // Missing Anthropic auth → an actionable in-chat sign-in prompt, not a dead error.
      if (errObj?.code === "no_auth" && /anthropic|claude/i.test(msg)) {
        items.push({ kind: "authPrompt", key: nextKey(), provider: "anthropic", text: msg });
      } else {
        items.push({ kind: "notice", key: nextKey(), text: compact(msg, 500), tone: retriable ? "warn" : "bad" });
      }
      // Auth-class failures (bad key, key limit, not signed in) kill the turn
      // before any model output. Mark the turn so its settlement can hand the
      // user's message back to the composer instead of eating it.
      const code = errObj?.code ?? "";
      if (code === "no_auth" || /^http_(401|403)$/.test(code) || (/^http_429$/.test(code) && !retriable)) {
        session.authFailedTurn = true;
      }
      // Provider errors are diagnostics, not terminal turn boundaries. Retry
      // or failover may follow; only turn_end/interrupt settlement unlocks UI.
      // Preserve — never CREATE — the busy gate: an error landing on an idle
      // card must not park its composer in Stop mode.
      if (session.busy && retriable) session.activity = "retrying provider";
      break;
    }
    case "desktop_error":
      // A daemon transport failure makes an in-flight approval delivery
      // ambiguous. Never leave its controls permanently disabled; exact prompt
      // IDs and late-response quarantine keep a retry from approving another
      // request.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "permission" && item.submitting && !item.decided) {
          items[i] = { ...item, submitting: undefined };
        }
      }
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
