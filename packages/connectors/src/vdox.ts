// VdoxConnector — text-to-video generation via the VDO-X REST API.
//
// VDO-X (https://www.vdo-x.art) exposes a single async endpoint:
//   POST https://www.vdo-x.art/api/v1/generate  { prompt, model_id }
//     -> { task_id }         (202, generation runs async)
//   an HMAC-signed webhook then delivers the finished 1080p MP4 URL.
//
// Auth: per-user "xk-"-prefixed key (Bearer). Rate limits: 10/min free,
// 100/min paid. Price: ~$0.01 per 1080p video.
//
// Key is read from env VDOX_API_KEY (never inlined). Get one at
// https://www.vdo-x.art/text-to-video-api ("Get API key free").
//
// NOTE (verify against /text-to-video-api docs once a key is issued):
//   - exact auth header (Bearer assumed; some tenants use x-api-key)
//   - webhook signature scheme (HMAC alg + header name) — verifyWebhook()
//     below implements HMAC-SHA256 over the raw body, which is the common
//     pattern; confirm before trusting inbound payloads.

import { createHmac, timingSafeEqual } from "node:crypto";

const VDOX_BASE_URL = process.env.VDOX_BASE_URL ?? "https://www.vdo-x.art";
const VDOX_GENERATE_PATH = "/api/v1/generate";

/** Models VDO-X exposes at the flat $0.01 text-to-video price. */
export const VDOX_MODELS = {
  klingPro: "kling-3.0-pro", // default — highest fidelity
  klingTurbo: "kling-3.0-turbo", // faster
  ltxFast: "ltx-2-fast", // cheapest/quickest
} as const;

export type VdoxModelId = (typeof VDOX_MODELS)[keyof typeof VDOX_MODELS];

export interface VdoxGenerateInput {
  prompt: string;
  /** Defaults to kling-3.0-pro if omitted. */
  model_id?: VdoxModelId | string;
  /** Optional passthrough — webhook target the finished MP4 URL is POSTed to. */
  webhook_url?: string;
}

export interface VdoxGenerateResult {
  ok: boolean;
  /** Async task handle to correlate with the webhook delivery. */
  task_id?: string;
  status?: number;
  error?: string;
  raw?: unknown;
}

export class VdoxConnector {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = opts.apiKey ?? process.env.VDOX_API_KEY ?? "";
    this.baseUrl = (opts.baseUrl ?? VDOX_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("fetch is not available for VdoxConnector");
  }

  /** True when an xk- key is present (does not validate it remotely). */
  get configured(): boolean {
    return this.apiKey.startsWith("xk-");
  }

  /** Kick off a generation. Returns a task_id; the MP4 arrives via webhook. */
  async generate(input: VdoxGenerateInput): Promise<VdoxGenerateResult> {
    if (!this.apiKey) return { ok: false, error: "VDOX_API_KEY not set" };
    const body = {
      prompt: input.prompt,
      model_id: input.model_id ?? VDOX_MODELS.klingPro,
      ...(input.webhook_url ? { webhook_url: input.webhook_url } : {}),
    };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${VDOX_GENERATE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const raw = await res.json().catch(() => undefined);
      if (!res.ok) {
        return { ok: false, status: res.status, error: `VDO-X generate failed: HTTP ${res.status}`, raw };
      }
      const task_id =
        (raw as { task_id?: string; id?: string } | undefined)?.task_id ??
        (raw as { id?: string } | undefined)?.id;
      return { ok: true, status: res.status, task_id, raw };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Verify an inbound webhook's HMAC-SHA256 signature over the raw body.
   * Confirm alg + header name against VDO-X docs before relying on this.
   */
  verifyWebhook(rawBody: string, signatureHeader: string, secret = process.env.VDOX_WEBHOOK_SECRET ?? ""): boolean {
    if (!secret || !signatureHeader) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader.replace(/^sha256=/, ""));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

let instance: VdoxConnector | null = null;

/** Process-wide singleton (mirrors getInstagrowth()). */
export function getVdox(): VdoxConnector {
  if (!instance) instance = new VdoxConnector();
  return instance;
}
