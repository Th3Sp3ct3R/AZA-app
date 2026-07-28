// Voice — the desktop app's bridge to the local voice sidecar (voice_service/,
// ws://127.0.0.1:8765). The sidecar already ships Kokoro TTS + faster-whisper
// STT and is auto-spawned by the Rust shell; this module is the app-side client
// the UI was missing. Everything here is local-first and degrades to silence /
// the legacy STT path when the sidecar isn't running.
//
// Three pieces:
//   • sanitizeForSpeech — turn a markdown chat reply into something worth
//     hearing: no emoji, no "hashtag", no "asterisk asterisk", URLs as domains,
//     code blocks summarized, not read out line by line.
//   • TtsClient — a persistent /tts WebSocket + an audio queue player, with a
//     hard stop() for barge-in.
//   • sidecarTranscribe — push-to-talk STT against /stt (mic captured
//     server-side, so no WebView getUserMedia permission dance).

import { useCallback, useEffect, useRef, useState } from "react";

export let VOICE_HTTP_BASE = "http://127.0.0.1:8765";
export let VOICE_WS_BASE = "ws://127.0.0.1:8765";
export const DEFAULT_BUILTIN_VOICE = "af_heart";

// Per-launch auth token the sidecar requires (set by the Rust shell; read once
// via ares_voice_status). Without it the sidecar closes every socket 4401.
let voiceToken = "";
export function setVoiceToken(token: string): void { voiceToken = token || ""; }
export function setVoiceEndpoint(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  VOICE_HTTP_BASE = `http://127.0.0.1:${port}`;
  VOICE_WS_BASE = `ws://127.0.0.1:${port}`;
}
/** Append ?token=… to a sidecar URL when we have one. */
export function voiceUrl(base: string, path: string): string {
  return voiceToken ? `${base}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(voiceToken)}` : `${base}${path}`;
}

export interface VoiceInfo {
  id: string;
  label: string;
  accent?: string;
  gender?: string;
  tier?: string | number;
  character?: string;
}

// ── Speakability ─────────────────────────────────────────────────────────
// A chat reply is written to be READ. Spoken verbatim it's miserable — the TTS
// pronounces "#", "**", every emoji name, and reads 200-char URLs and whole
// code blocks aloud. Strip it down to the words a person would actually say.

const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}]/gu;

export function sanitizeForSpeech(input: string): string {
  if (!input) return "";
  let t = input;

  // Fenced code blocks → a short spoken placeholder (never read code aloud).
  t = t.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang: string | undefined, body: string) => {
    const lines = body.split("\n").filter((l) => l.trim()).length;
    return ` (${lang ? `${lang} ` : ""}code block, ${lines} line${lines === 1 ? "" : "s"}) `;
  });
  // Inline code → its contents, sans backticks.
  t = t.replace(/`([^`]+)`/g, "$1");

  // Images ![alt](url) → nothing; links [text](url) → the visible text.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Bare URLs → their domain ("according to example.com" not the whole path).
  t = t.replace(/https?:\/\/([^\s/]+)[^\s]*/g, (_m, host: string) => host.replace(/^www\./, ""));

  // Markdown emphasis / headings / quotes / list bullets / rules.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");      // # headings
  t = t.replace(/^\s{0,3}>\s?/gm, "");           // > blockquotes
  t = t.replace(/^\s*[-*+]\s+/gm, "");           // - bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, "");           // 1. ordered markers
  t = t.replace(/^\s*[-*_]{3,}\s*$/gm, " ");      // --- horizontal rules
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");      // **bold** / __bold__
  t = t.replace(/(\*|_)(.*?)\1/g, "$2");          // *italic* / _italic_
  t = t.replace(/~~(.*?)~~/g, "$1");             // ~~strike~~

  // Hashtags → the word without the hash ("#winning" → "winning").
  t = t.replace(/(^|\s)#(\w+)/g, "$1$2");

  // Emoji + variation selectors → gone (don't speak "sparkles").
  t = t.replace(EMOJI_RE, "");

  // Markdown tables read as pipe soup — turn cell separators into pauses.
  t = t.replace(/^\s*\|?[-:|\s]+\|?\s*$/gm, " "); // separator rows
  t = t.replace(/\s*\|\s*/g, ", ");

  // Collapse whitespace and stray punctuation left behind.
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/\s+([.,!?;:])/g, "$1");
  t = t.replace(/(^|\n)[,;:]\s*/g, "$1");

  return t.trim();
}

// ── Audio output: ONE format-agnostic contract for every voice engine ───────
//
// THE contract any TTS provider (built-in sidecar, a Piper/Kokoro/Coqui skill,
// or an API like ElevenLabs/OpenAI) plugs into: return base64-encoded audio in
// ANY standard container — WAV (any sample rate/bit depth), MP3, OGG/Opus,
// FLAC, WebM — plus an advisory `mime`. That's it. Playback runs it through the
// Web Audio API's decodeAudioData, which:
//   • accepts all those formats at any sample rate (no 22050-vs-44100 games),
//   • decodes an in-memory ArrayBuffer, so it is NOT subject to the CSP
//     media-src blob: trap that silently killed <audio> playback,
//   • surfaces decode failures loudly instead of a silent <audio> onerror.
// A provider never has to care how the desktop plays sound — it just hands over
// bytes. This is the stable seam so we never chase per-engine playback bugs again.

// One shared AudioContext for the whole app (browsers cap the count). Started
// suspended until a user gesture, so we resume it on the first interaction —
// otherwise the very first spoken reply is silent.
let sharedAudioCtx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!sharedAudioCtx) {
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    sharedAudioCtx = new Ctor();
  }
  if (sharedAudioCtx.state === "suspended") void sharedAudioCtx.resume();
  return sharedAudioCtx;
}
if (typeof window !== "undefined") {
  const wake = () => { try { audioCtx(); } catch { /* no Web Audio — browser-speech fallback covers it */ } };
  window.addEventListener("pointerdown", wake, { once: true });
  window.addEventListener("keydown", wake, { once: true });
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ── TTS client ─────────────────────────────────────────────────────────────

interface TtsChunk { type: string; audio?: string; mime?: string; message?: string }

/** A persistent /tts WebSocket with a serial audio-queue player. speak() streams
 *  one clip per sentence and plays them in order; stop() is an immediate barge-in
 *  (cancel the server + drop the queue + halt the current clip). All audio —
 *  sidecar or provider skill — flows through the SAME Web Audio decode path. */
export class TtsClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private queue: Array<{ bytes: ArrayBuffer; label?: string }> = []; // encoded audio awaiting decode+play
  private currentSource: AudioBufferSourceNode | null = null;
  private browserUtterance: SpeechSynthesisUtterance | null = null;
  private browserQueued = 0;
  private playing = false;
  private seq = 0;
  private cancelEpoch = 0;
  /** Sidecar is up but its TTS engine didn't install (e.g. Python 3.13 refused
   *  kokoro) — speak() should go straight to the browser voice. */
  private serverTtsUnavailable = false;
  private onState?: (speaking: boolean) => void;
  /** Karaoke: the text of the clip playing right now (null = quiet). */
  private onUtterance?: (text: string | null) => void;
  /** Maps a sidecar speak-request id → its text, so audio frames get labeled. */
  private pendingTexts = new Map<string, string>();

  constructor(onState?: (speaking: boolean) => void, onUtterance?: (text: string | null) => void) {
    this.onState = onState;
    this.onUtterance = onUtterance;
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    const pending = new Promise<WebSocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(voiceUrl(VOICE_WS_BASE, "/tts"));
      } catch (err) {
        reject(err);
        return;
      }
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("tts sidecar unreachable"));
      ws.onmessage = (e) => {
        let m: TtsChunk & { id?: string; available?: boolean };
        try { m = JSON.parse(e.data as string) as TtsChunk & { id?: string; available?: boolean }; } catch { return; }
        if (m.type === "ready") this.serverTtsUnavailable = m.available === false;
        if (m.type === "audio" && m.audio) {
          // Label each clip with the text of the speak request it came from, so
          // the UI can show what's being spoken (karaoke).
          this.enqueueAudio(m.audio, m.mime, m.id ? this.pendingTexts.get(m.id) : undefined);
        }
        if (m.type === "done" && m.id) {
          this.pendingTexts.delete(m.id);
          this.pump();
        }
      };
      ws.onclose = () => { if (this.ws === ws) this.ws = null; };
      this.ws = ws;
    });
    this.connecting = pending;
    void pending.finally(() => { if (this.connecting === pending) this.connecting = null; }).catch(() => {});
    return pending;
  }

  private pump(): void {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) {
      if (!this.currentSource && this.browserQueued === 0 && this.pendingTexts.size === 0) {
        this.onState?.(false);
        this.onUtterance?.(null);
      } else {
        // The sidecar accepted more speech but is still synthesizing it. Keep
        // speaking=true across that gap so hands-free mode cannot open the mic
        // in the middle of a working reply.
        this.onState?.(true);
      }
      return;
    }
    this.playing = true;
    this.onState?.(true);
    void this.playBytes(item.bytes, item.label);
  }

  /** Decode + play one encoded audio clip via Web Audio (format-agnostic). */
  private async playBytes(bytes: ArrayBuffer, label?: string): Promise<void> {
    const done = () => {
      this.playing = false;
      this.currentSource = null;
      this.pump();
    };
    try {
      const ctx = audioCtx();
      // decodeAudioData detaches its input, so decode a copy — keeps the queued
      // buffer intact if we ever need to retry.
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = done;
      this.currentSource = src;
      if (label) this.onUtterance?.(label);
      src.start();
    } catch (err) {
      // A decode failure is a REAL problem (a provider returned audio the engine
      // can't read) — log it instead of the old silent <audio> onerror that made
      // "nothing plays" undebuggable. Then move on so one bad clip can't wedge the queue.
      console.error("[voice] audio decode/playback failed:", err);
      done();
    }
  }

  private browserVoice(voice?: string): SpeechSynthesisVoice | undefined {
    const synth = window.speechSynthesis;
    if (!synth) return undefined;
    const requested = (voice ?? "").toLowerCase();
    const voices = synth.getVoices();
    if (requested) {
      const match = voices.find((v) =>
        v.name.toLowerCase() === requested ||
        v.voiceURI.toLowerCase() === requested ||
        v.lang.toLowerCase() === requested ||
        v.name.toLowerCase().includes(requested.replace(/[_-]/g, " ")),
      );
      if (match) return match;
    }
    return voices.find((v) => /^en[-_]/i.test(v.lang)) ?? voices[0];
  }

  private speakWithBrowser(text: string, voice?: string, speed = 1): Promise<void> {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
      return Promise.reject(new Error("browser speech synthesis unavailable"));
    }
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.browserQueued = Math.max(0, this.browserQueued - 1);
        if (this.browserUtterance === utterance) this.browserUtterance = null;
        this.onState?.(this.browserQueued > 0 || this.playing || this.queue.length > 0);
        if (error) reject(error);
        else resolve();
      };
      const selected = this.browserVoice(voice);
      if (selected) utterance.voice = selected;
      utterance.rate = Math.min(2, Math.max(0.5, speed || 1));
      utterance.onstart = () => this.onState?.(true);
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error("browser speech synthesis failed"));
      this.browserQueued += 1;
      this.browserUtterance = utterance;
      synth.speak(utterance);
    });
  }

  /** Speak text through the built-in sidecar (already spoken-cleaned, or we
   *  clean it here). */
  async speak(text: string, voice: string, speed = 1): Promise<void> {
    const clean = sanitizeForSpeech(text);
    if (!clean) return;
    const epoch = this.cancelEpoch;
    try {
      const ws = await this.connect();
      if (epoch !== this.cancelEpoch) return;
      if (this.serverTtsUnavailable) throw new Error("sidecar tts unavailable");
      const id = `s${++this.seq}`;
      this.pendingTexts.set(id, clean);
      ws.send(JSON.stringify({ type: "speak", id, text: clean, voice: voice || DEFAULT_BUILTIN_VOICE, speed }));
    } catch {
      this.onUtterance?.(clean);
      await this.speakWithBrowser(clean, voice, speed).finally(() => this.onUtterance?.(null));
    }
  }

  /** Enqueue externally-produced audio (a TTS-provider SKILL's output) onto the
   *  SAME queue + player, so barge-in and ordering work identically whether the
   *  audio came from the built-in sidecar or a provider skill. */
  enqueueAudio(base64: string, mime?: string, label?: string): void {
    if (!base64) return;
    void mime; // advisory only — decodeAudioData sniffs the container itself.
    this.queue.push({ bytes: base64ToBytes(base64), label });
    this.pump();
  }

  /** Barge-in: silence everything now. */
  stop(): void {
    this.cancelEpoch += 1;
    this.queue = [];
    this.pendingTexts.clear();
    this.onUtterance?.(null);
    if (this.currentSource) { try { this.currentSource.stop(); } catch { /* already ended */ } this.currentSource = null; }
    if (this.browserUtterance) {
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
      this.browserUtterance = null;
    }
    this.browserQueued = 0;
    this.playing = false;
    try { this.ws?.send(JSON.stringify({ type: "cancel" })); } catch { /* ignore */ }
    this.onState?.(false);
  }

  dispose(): void {
    this.stop();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}

/** Fetch the sidecar's voice catalog (empty when it isn't running). */
export async function fetchVoices(signal?: AbortSignal): Promise<{ voices: VoiceInfo[]; default: string }> {
  try {
    const res = await fetch(voiceUrl(VOICE_HTTP_BASE, "/voices"), { signal });
    if (!res.ok) return { voices: [], default: "" };
    const data = (await res.json()) as { voices?: VoiceInfo[]; default?: string };
    return { voices: data.voices ?? [], default: data.default ?? "" };
  } catch {
    return { voices: [], default: "" };
  }
}

// ── React hook: the voice bus ───────────────────────────────────────────────

/** A TTS-provider SKILL: given text, return audio (or null). When set, the bus
 *  routes speech through it instead of the built-in sidecar — this is how any
 *  voice engine (Piper, ElevenLabs, …) overrides the default. */
export type ProviderSpeak = (text: string, voice: string, speed: number) => Promise<{ audio?: string; mime?: string } | null>;

export interface UseTtsOptions {
  enabled: boolean;
  voice: string;
  speed?: number;
  /** When present, speech is produced by this provider skill; the built-in
   *  sidecar is the fallback (and the default when this is undefined). */
  provider?: ProviderSpeak;
  /** Karaoke: fired with the text of the clip currently playing (null = quiet). */
  onUtterance?: (text: string | null) => void;
}

/** The app's TTS bus. Keeps one TtsClient for the session; `speak` no-ops when
 *  disabled, `stop` is the barge-in used by conversation mode + manual stop. */
export function useTts(opts: UseTtsOptions) {
  const clientRef = useRef<TtsClient | null>(null);
  const providerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const speechEpochRef = useRef(0);
  // The audio queue and the provider-synth pipeline each report activity; the
  // spoken state is the OR of both. Without this, `speaking` flickered to false
  // in the gap between one sentence finishing and the next slow synth landing —
  // which read as "it stopped mid-reply" and tripped conversation mode into
  // listening before Ares was actually done.
  const clientSpeakingRef = useRef(false);
  const pendingSynthRef = useRef(0); // provider synths queued or in flight
  const [speaking, setSpeaking] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const recomputeSpeaking = useCallback(() => {
    setSpeaking(clientSpeakingRef.current || pendingSynthRef.current > 0);
  }, []);

  useEffect(() => {
    const client = new TtsClient(
      (s) => { clientSpeakingRef.current = s; recomputeSpeaking(); },
      (text) => optsRef.current.onUtterance?.(text),
    );
    clientRef.current = client;
    return () => { client.dispose(); clientRef.current = null; };
  }, [recomputeSpeaking]);

  // Disabling voice mid-utterance stops it immediately.
  useEffect(() => {
    if (!opts.enabled) {
      speechEpochRef.current += 1;
      providerQueueRef.current = Promise.resolve();
      pendingSynthRef.current = 0;
      clientRef.current?.stop();
      recomputeSpeaking();
    }
  }, [opts.enabled, recomputeSpeaking]);

  const speak = useCallback((text: string, o2?: { force?: boolean }) => {
    const o = optsRef.current;
    // `force` speaks even with the voice toggle off (read-aloud selection,
    // voice previews) — an explicit user click IS the consent.
    if (!o.enabled && !o2?.force) return;
    const client = clientRef.current;
    if (!client) return;
    const selectedVoice = o.voice || DEFAULT_BUILTIN_VOICE;
    if (o.provider) {
      // Provider skill: sanitize, hand it the clean text, play what it returns.
      const clean = sanitizeForSpeech(text);
      if (!clean) return;
      const epoch = speechEpochRef.current;
      // Count this synth as pending NOW (before it's even started synthesizing)
      // so `speaking` stays true continuously across the whole multi-sentence
      // reply — no false gap that drops the tail or triggers early listening.
      pendingSynthRef.current += 1;
      recomputeSpeaking();
      const settle = () => { pendingSynthRef.current = Math.max(0, pendingSynthRef.current - 1); recomputeSpeaking(); };
      const force = o2?.force === true;
      const stillWanted = () => (optsRef.current.enabled || force) && epoch === speechEpochRef.current;
      const run = providerQueueRef.current.then(async () => {
        const latest = optsRef.current;
        const currentClient = clientRef.current;
        if (!currentClient || !stillWanted()) return;
        const voice = latest.voice || selectedVoice;
        const speed = latest.speed ?? 1;
        const provider = latest.provider;
        if (!provider) {
          await currentClient.speak(clean, voice || DEFAULT_BUILTIN_VOICE, speed).catch(() => {});
          return;
        }
        try {
          const out = await provider(clean, latest.voice, speed);
          if (!clientRef.current || !stillWanted()) return;
          if (out?.audio) clientRef.current.enqueueAudio(out.audio, out.mime, clean);
          else await clientRef.current.speak(clean, voice || DEFAULT_BUILTIN_VOICE, speed).catch(() => {});
        } catch {
          if (clientRef.current && stillWanted()) {
            await clientRef.current.speak(clean, voice || DEFAULT_BUILTIN_VOICE, speed).catch(() => {});
          }
        }
      });
      // .catch keeps one failed synth from breaking the chain for later sentences.
      providerQueueRef.current = run.finally(settle).catch(() => {});
      return;
    }
    void client.speak(text, selectedVoice, o.speed ?? 1).catch(() => {});
  }, [recomputeSpeaking]);

  const stop = useCallback(() => {
    speechEpochRef.current += 1;
    providerQueueRef.current = Promise.resolve();
    pendingSynthRef.current = 0;
    clientRef.current?.stop();
    recomputeSpeaking();
  }, [recomputeSpeaking]);
  const playAudio = useCallback((audio: string, mime?: string) => clientRef.current?.enqueueAudio(audio, mime), []);

  /** Hear a SPECIFIC voice before selecting it (the Voice Hub ▶). Uses the
   *  provider skill when one is active, else the sidecar — regardless of the
   *  voice toggle (the click is the consent). */
  const preview = useCallback((voiceId: string, text = "Hey — this is what I sound like. Pick me if you like it.") => {
    const client = clientRef.current;
    if (!client) return;
    const o = optsRef.current;
    if (o.provider) {
      void o.provider(text, voiceId, o.speed ?? 1)
        .then((out) => { if (out?.audio) clientRef.current?.enqueueAudio(out.audio, out.mime, text); })
        .catch(() => { /* preview is best-effort */ });
      return;
    }
    void client.speak(text, voiceId, o.speed ?? 1).catch(() => {});
  }, []);

  return { speak, stop, playAudio, preview, speaking };
}

// ── Sidecar STT (push-to-talk) ───────────────────────────────────────────────

export interface SttHandle {
  /** Resolves with the transcript (empty string if nothing recognized). */
  stop: () => Promise<string>;
  cancel: () => void;
  /** Resolves when the transcript lands — whether the client called stop() or
   *  the sidecar's VAD ended the utterance on its own (auto mode). This is what
   *  hands-free flows await: talk, stop talking, the text arrives. */
  transcript: Promise<string>;
}

/**
 * Start a push-to-talk STT capture on the sidecar. The sidecar records the mic
 * server-side; we get status events and, on stop, the transcript. Rejects fast
 * if the sidecar isn't reachable so the caller can fall back to the legacy path.
 */
export function sidecarListen(
  onStatus?: (s: "connecting" | "listening" | "transcribing") => void,
  opts?: { auto?: boolean },
): Promise<SttHandle> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(voiceUrl(VOICE_WS_BASE, "/stt"));
    } catch (err) {
      reject(err);
      return;
    }
    let settledOpen = false;

    // ONE shared transcript promise: resolved by an explicit stop(), by the
    // sidecar's VAD auto-stop, by cancel (empty), or by the socket dying (empty).
    let settleTranscript: (t: string) => void = () => {};
    let transcriptSettled = false;
    const transcript = new Promise<string>((res) => {
      settleTranscript = (t: string) => { if (!transcriptSettled) { transcriptSettled = true; res(t); } };
    });

    const failOpen = () => { if (!settledOpen) { settledOpen = true; reject(new Error("stt sidecar unreachable")); } };
    ws.onerror = failOpen;
    ws.onclose = () => { failOpen(); settleTranscript(""); };

    ws.onopen = () => {
      onStatus?.("connecting");
      ws.send(JSON.stringify({ type: "listen_start", auto: opts?.auto === true }));
    };
    ws.onmessage = (e) => {
      let m: { type: string; text?: string; available?: boolean };
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.type === "ready" && m.available === false) { failOpen(); try { ws.close(); } catch { /* ignore */ } return; }
      if (m.type === "listening") { if (!settledOpen) { settledOpen = true; resolve(handle); } onStatus?.("listening"); }
      if (m.type === "transcribing") onStatus?.("transcribing");
      if (m.type === "transcript") { settleTranscript(m.text ?? ""); try { ws.close(); } catch { /* ignore */ } }
      if (m.type === "cancelled") { settleTranscript(""); try { ws.close(); } catch { /* ignore */ } }
      if (m.type === "error") settleTranscript("");
    };

    const handle: SttHandle = {
      transcript,
      stop: () => {
        try { ws.send(JSON.stringify({ type: "listen_stop" })); } catch { settleTranscript(""); }
        return transcript;
      },
      cancel: () => { settleTranscript(""); try { ws.send(JSON.stringify({ type: "listen_cancel" })); ws.close(); } catch { /* ignore */ } },
    };
  });
}

// ── Wake word ("Hey Ares") ──────────────────────────────────────────────────

export interface WakeHandle {
  /** Re-arm listening after the follow-up command capture finished. */
  resume: () => void;
  dispose: () => void;
}

/**
 * Open the sidecar's wake-word loop. `onWake` fires each time the wake phrase
 * is heard; the loop then PAUSES (so /stt can own the mic for the command) until
 * resume() is called. Rejects fast when the sidecar/wake engine isn't available
 * so callers can retry later without a dangling socket.
 */
export function wakeListen(onWake: (heard: string) => void, onDead?: () => void): Promise<WakeHandle> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(voiceUrl(VOICE_WS_BASE, "/wake"));
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let disposed = false;
    const fail = (why: string) => { if (!settled) { settled = true; reject(new Error(why)); } };
    // Pre-arm failures reject the promise; a POST-arm close (sidecar crash or
    // restart) used to die silently with the UI stuck on "listening" — now it
    // notifies the caller so the wake loop can re-arm.
    const dead = () => { if (settled && !disposed) { disposed = true; onDead?.(); } };
    ws.onerror = () => { fail("wake sidecar unreachable"); dead(); };
    ws.onclose = () => { fail("wake socket closed"); dead(); };
    ws.onopen = () => ws.send(JSON.stringify({ type: "wake_start" }));
    ws.onmessage = (e) => {
      let m: { type: string; text?: string; available?: boolean };
      try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.type === "ready" && m.available === false) { fail("wake engine unavailable"); try { ws.close(); } catch { /* ignore */ } return; }
      if (m.type === "waking" && !settled) {
        settled = true;
        resolve({
          resume: () => { try { ws.send(JSON.stringify({ type: "wake_resume" })); } catch { /* ignore */ } },
          dispose: () => { disposed = true; try { ws.send(JSON.stringify({ type: "wake_stop" })); ws.close(); } catch { /* ignore */ } },
        });
      }
      if (m.type === "wake") onWake(m.text ?? "");
    };
  });
}
