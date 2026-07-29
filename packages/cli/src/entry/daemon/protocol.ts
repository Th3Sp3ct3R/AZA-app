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
  /** operator_control payload: "halt" engages the kill switch, "resume" releases it. */
  action?: string;
  /** operator_control halt reason (freeform, logged with the kill-switch flag file). */
  reason?: string;
  /** skill_invoke payload — JSON handed to the skill's handler(input, ctx). */
  input?: unknown;
  /** skill_invoke correlation id — echoed back in skill_result so the UI can
   *  match a response to the exact call (TTS utterances, surface clicks). */
  invokeId?: string;
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
  private commands = new AsyncQueue<DaemonInputCommand>();
  private permissionResponses: DaemonInputCommand[] = [];
  private permissionWaiters: Array<{ id?: string; resolve: (command: DaemonInputCommand | null) => void }> = [];
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

  async waitForPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
    const response = await this.takePermissionResponse(request.id);
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
    for (const waiter of this.permissionWaiters.splice(0)) waiter.resolve(null);
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
    const waiterIndex = this.permissionWaiters.findIndex((waiter) => {
      if (!waiter.id || !responseId) return true;
      return waiter.id === responseId;
    });
    if (waiterIndex >= 0) {
      const [waiter] = this.permissionWaiters.splice(waiterIndex, 1);
      waiter.resolve(command);
      return;
    }
    this.permissionResponses.push(command);
  }

  private takePermissionResponse(id?: string): Promise<DaemonInputCommand | null> {
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
    return new Promise((resolve) => this.permissionWaiters.push({ id: requestId, resolve }));
  }
}
