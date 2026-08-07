// TelegramChannelAdapter — adapts the existing TelegramBridge to the
// ChannelBridge runtime interface so the Garrison ChannelManager can
// start, stop, and configure the Telegram bridge from the Tauri front-end.
//
// The adapter holds runtime configuration (token, allowed chats) and
// lazily creates/destroys the real TelegramBridge on start/stop.
//
// NOTE: this file deliberately does NOT import from @ares/garrison to
// avoid a circular dependency. The interface shapes here structurally
// match garrison's ChannelBridge + ChannelParticipant. When registering
// with the ChannelManager, pass this as the factory return value.

export interface ChannelParticipant {
  chatId: number;
  name: string;
  role: "owner" | "member";
  addedAt: string;
  lastSeenAt?: string;
}

export interface ChannelBridgeContract {
  readonly name: string;
  readonly running: boolean;
  readonly configured: boolean;
  readonly participantCount: number;
  readonly lastError?: string;
  readonly participants: ChannelParticipant[];
  configure(opts: { token?: string; allowedChatIds?: number[]; ownerChatIds?: number[] }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

import type { TelegramApiLike } from "./bridge.js";

export interface TelegramChannelAdapterOptions {
  apiFactory: (token: string) => TelegramApiLike;
  gateway: { url: string; token: string };
  rosterPath: string;
  log?: (line: string) => void;
}

export class TelegramChannelAdapter implements ChannelBridgeContract {
  readonly name = "telegram";
  private readonly apiFactory: (token: string) => TelegramApiLike;
  private readonly gateway: { url: string; token: string };
  private readonly rosterPath: string;
  private readonly log: (line: string) => void;

  private _token: string | undefined;
  private _allowedChatIds: number[] = [];
  private _ownerChatIds: number[] = [];
  private _running = false;
  private _error: string | undefined;

  // The real bridge (lazy — only lives while running).
  private bridge: import("./bridge.js").TelegramBridge | undefined;

  constructor(opts: TelegramChannelAdapterOptions) {
    this.apiFactory = opts.apiFactory;
    this.gateway = opts.gateway;
    this.rosterPath = opts.rosterPath;
    this.log = opts.log ?? (() => {});
  }

  get running(): boolean { return this._running; }
  get configured(): boolean { return !!this._token && this._allowedChatIds.length > 0; }
  get lastError(): string | undefined { return this._error; }
  get participantCount(): number { return this._allowedChatIds.length; }
  get participants(): ChannelParticipant[] {
    return this._allowedChatIds.map((chatId, i) => ({
      chatId,
      name: this._ownerChatIds.includes(chatId) ? `owner-${i}` : `member-${i}`,
      role: (this._ownerChatIds.includes(chatId) ? "owner" : "member") as "owner" | "member",
      addedAt: new Date().toISOString(),
    }));
  }

  async configure(opts: { token?: string; allowedChatIds?: number[]; ownerChatIds?: number[] }): Promise<void> {
    if (opts.token !== undefined) this._token = opts.token;
    if (opts.allowedChatIds !== undefined) this._allowedChatIds = [...opts.allowedChatIds];
    if (opts.ownerChatIds !== undefined) this._ownerChatIds = [...opts.ownerChatIds];
    this._error = undefined;
    this.log(`telegram adapter: configured (token=${!!this._token}, chats=${this._allowedChatIds.length})`);
  }

  async start(): Promise<void> {
    if (!this._token) throw new Error("telegram: no bot token configured");
    if (this._allowedChatIds.length === 0) throw new Error("telegram: no allowed chats configured");
    if (this._running) return;

    const api = this.apiFactory(this._token);
    const { TelegramBridge } = await import("./bridge.js");

    this.bridge = new TelegramBridge({
      api,
      gateway: this.gateway,
      allowedChatIds: this._allowedChatIds,
      ownerChatIds: this._ownerChatIds.length > 0 ? this._ownerChatIds : undefined,
      clientName: "desktop",
      log: this.log,
    });
    this._running = true;
    this._error = undefined;
    this.log("telegram adapter: started");
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.bridge = undefined;
    this.log("telegram adapter: stopped");
  }
}
