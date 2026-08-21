// NDJSON daemon-protocol plumbing: the stdin command shape, the async command
// queue, and the router that separates permission responses / interrupts from
// the main command stream. Command/event names and shapes are a hard contract
// with the desktop shell — do not change them here.

import { createInterface } from "node:readline/promises";
import type { PermissionPromptDecision } from "@ares/protocol";
import type { ToolPermissionRequest } from "@ares/core";
import type { PermissionSettings } from "../../permissionPolicy.js";
import { cleanCommandId, normalizePermissionDecision } from "../permissions.js";

export interface DaemonInputCommand {
  type?: string;
  /** gateway_connect */
  token?: string;
  url?: string;
  /** bug_report — optional user description of what went wrong. */
  note?: string;
  /** discover_custom_models — OpenAI-compatible base URL to probe. */
  base?: string;
  goal?: string;
  /** Structured hands-free mode; excluded from goal classification/history. */
  voice?: boolean;
  command?: string;
  level?: string;
  id?: string;
  decision?: string;
  routing?: unknown;
  /** set_permissions payload — owner permission posture toggles. */
  permissions?: PermissionSettings;
  key?: string;
  model?: string;
  provider?: string;
  /** Custom OpenAI-compatible provider base URL (provider_key with provider="custom"). */
  baseUrl?: string;
  config?: unknown;
  name?: string;
  enabled?: boolean;
  days?: number;
  depth?: number;
  /** consciousness_look_away pause duration. */
  seconds?: number;
  text?: string;
  /** New session name for session_rename (empty clears the custom label). */
  label?: string;
  /** OAuth: provider id + app credentials for oauth_* commands. */
  clientId?: string;
  clientSecret?: string;
  /** Embedded-browser bridge result fields (webview_result). */
  cmdId?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  /** Which UI chat/session this command targets (multi-session daemon). */
  sessionId?: string;
  /** Stable identity for one logical send/steer. Retrying the command must
   * reuse this value so canonical admission remains exactly once. */
  inputId?: string;
  /** workflow_mode payload — the owner's explicit "plan" | "build" choice. */
  mode?: string;
  /** operator_control payload: "halt" engages the kill switch, "resume" releases it. */
  action?: string;
  /** operator_control halt reason (freeform, logged with the kill-switch flag file). */
  reason?: string;
  /** skill_invoke payload — JSON handed to the skill's handler(input, ctx). */
  input?: unknown;
  /** skill_invoke correlation id — echoed back in skill_result so the UI can
   *  match a response to the exact call (TTS utterances, surface clicks). */
  invokeId?: string;
  /** computer_screen — open the agent computer's screen in watch-only mode. */
  viewOnly?: boolean;
  /** computer_mode — "host" or "sandbox" (sandbox-only work). Reuses `mode`. */
  /** cognitive_state has no payload beyond sessionId. */
  /** fleets_list / subagents_list — read-only subagent visibility; no payload
   *  beyond sessionId. Replies are `fleets_list` / `subagents_list` events. */
  /** persona_write payload — the roster card the owner authored in HELM → Agents.
   *  `name`, `label`, `model` and `reason` reuse the fields above. */
  body?: string;
  description?: string;
  greeting?: string;
  triggers?: unknown[];
  tools?: unknown[];
  glyph?: string;
  tone?: string;
  autonomy?: string;
  effort?: string;
  maxTurns?: number;
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  shift(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

export class DaemonCommandRouter {
  private static readonly RETIRED_PERMISSION_LIMIT = 256;
  private commands = new AsyncQueue<DaemonInputCommand>();
  private permissionResponses: DaemonInputCommand[] = [];
  private permissionWaiters: Array<{
    id?: string;
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (command: DaemonInputCommand | null) => void;
  }> = [];
  /** Tombstones prevent a late click for a steering-cancelled prompt from
   * leaking forever or satisfying a later legacy (id-less) permission ask. */
  private readonly retiredPermissionIds = new Set<string>();
  private readonly retiredPermissionOrder: string[] = [];
  private retiredAnonymousPermissions = 0;
  private closed = false;
  /** Out-of-band interrupt — fires immediately on parse, even mid-turn while
   *  the command loop is busy streaming. Carries the command so the handler can
   *  route to the right session. */
  onInterrupt: ((command: DaemonInputCommand) => void) | null = null;

  constructor(private readonly onError: (error: string) => void) {}

  start(rl: ReturnType<typeof createInterface>): void {
    void this.pump(rl);
  }

  nextCommand(): Promise<DaemonInputCommand | null> {
    return this.commands.shift();
  }

  /** Re-enter work discovered at a durable boundary (for example, a steer that
   * became the next ordinary turn) through the exact same command pipeline as
   * owner input. This is intentionally not an out-of-band execution path. */
  enqueue(command: DaemonInputCommand): void {
    this.commands.push(command);
  }

  async waitForPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
    const response = await this.takePermissionResponse(request.id, request.signal);
    if (!response) return "deny";
    const decision = normalizePermissionDecision(response.decision);
    if (!decision) {
      this.onError("permission_response requires decision: allow_once|allow_always|deny");
      return "deny";
    }
    return decision;
  }

  close(): void {
    this.closed = true;
    this.commands.close();
    for (const waiter of this.permissionWaiters.splice(0)) this.settlePermissionWaiter(waiter, null);
  }

  private async pump(rl: ReturnType<typeof createInterface>): Promise<void> {
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let command: DaemonInputCommand;
        try {
          command = JSON.parse(line) as DaemonInputCommand;
        } catch {
          this.onError("invalid JSON command");
          continue;
        }
        if (command.type === "permission_response" || command.type === "permission") {
          this.pushPermissionResponse(command);
        } else if (command.type === "interrupt") {
          try {
            this.onInterrupt?.(command);
          } catch {
            // interrupting must never kill the daemon
          }
        } else {
          this.commands.push(command);
        }
      }
    } finally {
      this.close();
    }
  }

  private pushPermissionResponse(command: DaemonInputCommand): void {
    if (this.closed) return;
    const responseId = cleanCommandId(command.id);
    if (responseId && this.retiredPermissionIds.delete(responseId)) {
      const retiredIndex = this.retiredPermissionOrder.indexOf(responseId);
      if (retiredIndex >= 0) this.retiredPermissionOrder.splice(retiredIndex, 1);
      if (this.retiredAnonymousPermissions > 0) this.retiredAnonymousPermissions--;
      return;
    }
    if (!responseId && this.retiredAnonymousPermissions > 0) {
      this.retiredAnonymousPermissions--;
      return;
    }
    const waiterIndex = this.permissionWaiters.findIndex((waiter) => {
      if (!waiter.id || !responseId) return true;
      return waiter.id === responseId;
    });
    if (waiterIndex >= 0) {
      const [waiter] = this.permissionWaiters.splice(waiterIndex, 1);
      this.settlePermissionWaiter(waiter, command);
      return;
    }
    this.permissionResponses.push(command);
  }

  private takePermissionResponse(id?: string, signal?: AbortSignal): Promise<DaemonInputCommand | null> {
    const requestId = cleanCommandId(id);
    const responseIndex = this.permissionResponses.findIndex((command) => {
      const responseId = cleanCommandId(command.id);
      if (!requestId || !responseId) return true;
      return requestId === responseId;
    });
    if (responseIndex >= 0) {
      const [response] = this.permissionResponses.splice(responseIndex, 1);
      return Promise.resolve(response);
    }
    if (this.closed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: (typeof this.permissionWaiters)[number] = {
        id: requestId,
        signal,
        resolve,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.permissionWaiters.indexOf(waiter);
          if (index < 0) return;
          this.permissionWaiters.splice(index, 1);
          this.retirePermissionWaiter(waiter);
          this.settlePermissionWaiter(waiter, null);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.permissionWaiters.push(waiter);
      // Close the check→listener race if another owner aborted synchronously.
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  private settlePermissionWaiter(
    waiter: (typeof this.permissionWaiters)[number],
    command: DaemonInputCommand | null,
  ): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(command);
  }

  private retirePermissionWaiter(waiter: (typeof this.permissionWaiters)[number]): void {
    if (!waiter.id) {
      this.retiredAnonymousPermissions = Math.min(
        DaemonCommandRouter.RETIRED_PERMISSION_LIMIT,
        this.retiredAnonymousPermissions + 1,
      );
      return;
    }
    if (this.retiredPermissionIds.has(waiter.id)) return;
    // Some legacy clients omit response ids. Reserve one anonymous tombstone as
    // well so a late click for this explicit request can never approve the next
    // prompt through the router's compatibility wildcard.
    this.retiredAnonymousPermissions = Math.min(
      DaemonCommandRouter.RETIRED_PERMISSION_LIMIT,
      this.retiredAnonymousPermissions + 1,
    );
    this.retiredPermissionIds.add(waiter.id);
    this.retiredPermissionOrder.push(waiter.id);
    while (this.retiredPermissionOrder.length > DaemonCommandRouter.RETIRED_PERMISSION_LIMIT) {
      const oldest = this.retiredPermissionOrder.shift();
      if (oldest) this.retiredPermissionIds.delete(oldest);
    }
  }
}
