// ChannelManager — runtime lifecycle for channel bridges (Telegram, etc.).
//
// The manager sits between the Garrison gateway (which receives channel.*
// commands) and one or more channel bridges. Each bridge has its own lifecycle:
//   configured → started → running → stopped.
//
// Runtime configuration (token, allowed chats, roster) flows through the
// manager so the Tauri front-end can set up a bridge without env vars.

import type { ChannelParticipant, ChannelStatus } from "./protocol.js";

// ─── Bridge lifecycle contract ───────────────────────────────────────

export interface ChannelBridge {
  readonly name: string;
  /** Is the bridge currently running? (polling/connected) */
  readonly running: boolean;
  /** Has the bridge been configured with a token + allowed chats? */
  readonly configured: boolean;
  readonly participantCount: number;
  readonly lastError?: string;
  /** Roster snapshot (may be empty if bridge isn't started). */
  readonly participants: ChannelParticipant[];

  configure(opts: { token?: string; allowedChatIds?: number[]; ownerChatIds?: number[] }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─── Manager ─────────────────────────────────────────────────────────

export interface ChannelManagerOptions {
  /** Channel name → bridge factory (injected — the manager doesn't import Telegram). */
  bridges: Record<string, () => ChannelBridge>;
}

export class ChannelManager {
  private readonly factories: Record<string, () => ChannelBridge>;
  private readonly instances = new Map<string, ChannelBridge>();

  constructor(opts: ChannelManagerOptions) {
    this.factories = opts.bridges;
  }

  /** Provision (or retrieve) a bridge by name. Does NOT start it. */
  get(name: string): ChannelBridge | undefined {
    let bridge = this.instances.get(name);
    if (!bridge) {
      const factory = this.factories[name];
      if (!factory) return undefined;
      bridge = factory();
      this.instances.set(name, bridge);
    }
    return bridge;
  }

  /** Full status for all registered channels. */
  status(): ChannelStatus[] {
    const result: ChannelStatus[] = [];
    for (const [channel, bridge] of this.instances) {
      result.push({
        channel,
        running: bridge.running,
        connected: bridge.running, // true while polling
        configured: bridge.configured,
        participantCount: bridge.participantCount,
        lastError: bridge.lastError,
      });
    }
    // Also report registered-but-never-started channels
    for (const name of Object.keys(this.factories)) {
      if (!this.instances.has(name)) {
        const b = this.factories[name]();
        result.push({
          channel: name,
          running: false,
          connected: false,
          configured: b.configured,
          participantCount: 0,
        });
      }
    }
    return result;
  }

  /** Roster for a channel. */
  roster(channel: string): ChannelParticipant[] | undefined {
    return this.get(channel)?.participants;
  }

  /** Configure a channel (token, allowed chats). */
  async configure(
    channel: string,
    config: { token?: string; allowedChatIds?: number[]; ownerChatIds?: number[] },
  ): Promise<void> {
    const bridge = this.get(channel);
    if (!bridge) throw new Error(`unknown channel: ${channel}`);
    await bridge.configure(config);
  }

  /** Start a channel bridge (begin polling). */
  async start(channel: string): Promise<void> {
    const bridge = this.get(channel);
    if (!bridge) throw new Error(`unknown channel: ${channel}`);
    await bridge.start();
  }

  /** Stop a channel bridge. */
  async stop(channel: string): Promise<void> {
    const bridge = this.instances.get(channel);
    if (bridge) await bridge.stop();
  }

  /** Stop ALL running bridges (called on Garrison shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((b) => b.stop().catch(() => {})));
  }
}
