import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isDocumentMutation,
  livingSurfacePrompt,
  parseLivingSurfaceEnvelope,
  type LivingSurfaceEnvelope,
  type LivingSurfaceMutation,
} from "../../packages/protocol/src/livingSurface";
import {
  DEFAULT_BUILTIN_VOICE,
  setVoiceEndpoint,
  setVoiceToken,
  sidecarListen,
  useTts,
  type SttHandle,
} from "./voice";
import "./livingSurface.css";

interface BufferedEvent {
  seq: number;
  event: Record<string, unknown> & { type?: string; sessionId?: string };
}

interface SurfaceSnapshot {
  revision: number;
  title: string;
  html: string;
  css: string;
  js: string;
}

interface SurfaceLine {
  id: string;
  role: "user" | "ares" | "system";
  text: string;
}

interface PermissionVm {
  id: string;
  tool: string;
  reason: string;
}

/* Scripts are a designed capability now (the iframe runs them at an OPAQUE
 * origin with no parent access, and its CSP forbids every network request),
 * so the sanitizer's only remaining jobs are: no nested browsing contexts,
 * no document-level directives, and no external references. */
const FORBIDDEN_ELEMENTS = new Set([
  "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link",
]);

const DEFAULT_HTML = `
<canvas id="dream-embers"></canvas>
<main class="dream" data-ares-region="main">
  <header class="dream-mast">
    <span class="dream-index">ARES // LIVING SURFACE</span>
    <span class="dream-rev">REV 00 — VOID</span>
  </header>
  <section class="dream-core" data-ares-region="stage">
    <h1><span>Name your</span><br><em>wildest dream.</em></h1>
    <p>This space has no final form. Describe anything — an interface, a world, a game, a machine — and Ares will build it around you, alive and working.</p>
  </section>
  <section class="dream-whispers" data-ares-region="whispers">
    <span class="dream-whispers-label">OR WHISPER ONE OF THESE</span>
    <button data-ares-action="Build a dark-web style encrypted chat room where I talk directly with Ares. Make it fully functional: my messages appear instantly, Ares replies inside the room."><i>01</i>a dark-web chat room where we talk</button>
    <button data-ares-action="Build the world's most advanced Flappy Bird — playable right now with keyboard and mouse, juicy physics, particles, score, game over and restart."><i>02</i>the world's most advanced flappy bird</button>
    <button data-ares-action="Transform this entire surface into a scary, dark, fiery lava-pit control room with living embers and heat shimmer."><i>03</i>a scary, fiery lava-pit control room</button>
  </section>
  <footer class="dream-foot" data-ares-region="status"><i></i>the surface is listening — speak or type below</footer>
</main>`;

const DEFAULT_CSS = `
:root { color-scheme:dark; --ink:#050605; --paper:#e9e0d2; --ember:#ef5b32; --dim:#7c746a; }
* { box-sizing:border-box; }
html, body { min-height:100%; margin:0; background:var(--ink); color:var(--paper); overflow:hidden; }
body { font-family:"Aptos","Segoe UI",sans-serif; }
button, input, textarea { font:inherit; }
#dream-embers { position:fixed; inset:0; width:100vw; height:100vh; pointer-events:none; }
.dream { position:relative; z-index:1; min-height:100vh; display:flex; flex-direction:column; padding:clamp(30px,5vw,72px); }
.dream-mast { display:flex; justify-content:space-between; color:var(--dim); font:700 10px/1 "Cascadia Mono",monospace; letter-spacing:.26em; }
.dream-mast .dream-index { color:var(--ember); }
.dream-core { flex:1; display:flex; flex-direction:column; justify-content:center; max-width:1050px; }
.dream-core h1 { margin:0 0 30px; font:400 clamp(64px,10.5vw,168px)/.82 Georgia,serif; letter-spacing:-.07em; }
.dream-core h1 span { color:var(--paper); }
.dream-core h1 em { color:var(--ember); font-style:italic; text-shadow:0 0 90px rgba(239,91,50,.35); }
.dream-core p { max-width:640px; margin:0; color:#a89e92; font-size:clamp(16px,1.5vw,21px); line-height:1.6; }
.dream-whispers { display:flex; flex-wrap:wrap; align-items:center; gap:9px; margin-bottom:52px; }
.dream-whispers-label { width:100%; color:var(--dim); font:700 9px "Cascadia Mono",monospace; letter-spacing:.22em; margin-bottom:4px; }
.dream-whispers button { display:flex; align-items:center; gap:12px; padding:13px 18px; color:#b3a99d; background:rgba(255,255,255,.02); border:1px solid rgba(233,224,210,.13); cursor:pointer; font-size:14px; transition:.25s ease; }
.dream-whispers button:hover { color:var(--paper); border-color:rgba(239,91,50,.6); background:rgba(239,91,50,.07); transform:translateY(-3px); box-shadow:0 14px 40px rgba(0,0,0,.5); }
.dream-whispers i { color:var(--ember); font:700 10px "Cascadia Mono",monospace; font-style:normal; }
.dream-foot { color:var(--dim); font:10px "Cascadia Mono",monospace; letter-spacing:.12em; }
.dream-foot i { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--ember); margin-right:9px; box-shadow:0 0 14px var(--ember); animation:dreamPulse 1.6s ease-in-out infinite; }
@keyframes dreamPulse { 50% { opacity:.35; } }
@media (max-width:760px) { .dream-core h1 { font-size:64px; } .dream-whispers button { width:100%; } }
@media (prefers-reduced-motion:reduce) { .dream-foot i { animation:none; } }
`;

const DEFAULT_JS = `
(() => {
  const canvas = document.getElementById("dream-embers");
  if (!canvas || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0;
  const size = () => { w = canvas.width = innerWidth; h = canvas.height = innerHeight; };
  size(); addEventListener("resize", size);
  const embers = Array.from({ length: 42 }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    r: .6 + Math.random() * 1.8, s: .12 + Math.random() * .5,
    drift: (Math.random() - .5) * .3, glow: .25 + Math.random() * .6, t: Math.random() * 7,
  }));
  (function frame(now) {
    ctx.clearRect(0, 0, w, h);
    for (const e of embers) {
      e.y -= e.s; e.x += e.drift + Math.sin(now / 1400 + e.t) * .18;
      if (e.y < -8) { e.y = h + 8; e.x = Math.random() * w; }
      const a = e.glow * (0.55 + 0.45 * Math.sin(now / 900 + e.t));
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, 7);
      ctx.fillStyle = "rgba(239,91,50," + a.toFixed(3) + ")";
      ctx.shadowColor = "rgba(239,91,50,.8)"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
    }
    requestAnimationFrame(frame);
  })(0);
})();
`;

/* Injected ahead of the surface's own script. Everything the document may do
 * beyond rendering flows through here: postMessage up to the trusted host,
 * posts from Ares flowing back down. The document has no other outside line —
 * opaque origin means no parent DOM, no Tauri, and CSP means no network. */
const BRIDGE_SCRIPT = `
(() => {
  const queue = [];
  const listeners = [];
  window.ares = Object.freeze({
    send(text) {
      if (typeof text !== "string" || !text.trim()) return;
      parent.postMessage({ __ares: 1, type: "send", text: text.trim().slice(0, 6000) }, "*");
    },
    onPost(fn) {
      if (typeof fn !== "function") return;
      listeners.push(fn);
      for (const payload of queue.splice(0)) { try { fn(payload); } catch {} }
    },
  });
  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.__ares !== 1 || data.type !== "post") return;
    if (!listeners.length) { queue.push(data.payload); return; }
    for (const fn of listeners) { try { fn(data.payload); } catch {} }
  });
  document.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target.closest("[data-ares-action]") : null;
    if (!el) return;
    event.preventDefault();
    const action = el.getAttribute("data-ares-action");
    if (action) window.ares.send(action);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    const fields = {};
    new FormData(form).forEach((value, key) => { fields[key] = String(value); });
    const action = form.getAttribute("data-ares-action") || "Respond to this surface form";
    window.ares.send(action + "\\nStructured form values: " + JSON.stringify(fields));
  }, true);
  addEventListener("error", (event) => {
    parent.postMessage({ __ares: 1, type: "fault", message: String(event.message || event.error || "script error").slice(0, 400) }, "*");
  });
  addEventListener("unhandledrejection", (event) => {
    parent.postMessage({ __ares: 1, type: "fault", message: ("unhandled rejection: " + String(event.reason)).slice(0, 400) }, "*");
  });
})();
`;

function initialSnapshot(): SurfaceSnapshot {
  return { revision: 0, title: "The Void", html: DEFAULT_HTML, css: DEFAULT_CSS, js: DEFAULT_JS };
}

function snapshotKey(sessionId: string): string {
  return `ares.living-surface.${sessionId}`;
}

function historyKey(sessionId: string): string {
  return `${snapshotKey(sessionId)}.history`;
}

function loadSnapshot(sessionId: string): SurfaceSnapshot {
  try {
    const parsed = JSON.parse(localStorage.getItem(snapshotKey(sessionId)) ?? "null") as Partial<SurfaceSnapshot> | null;
    if (parsed && Number.isInteger(parsed.revision) && typeof parsed.html === "string" && typeof parsed.css === "string") {
      return {
        revision: Number(parsed.revision),
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 120) : "Living Surface",
        html: parsed.html.slice(0, 120_000),
        css: parsed.css.slice(0, 60_000),
        js: typeof parsed.js === "string" ? parsed.js.slice(0, 120_000) : "",
      };
    }
  } catch {
    // Corrupt experimental state falls back to the void rather than bricking.
  }
  return initialSnapshot();
}

function loadHistory(sessionId: string): SurfaceSnapshot[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(sessionId)) ?? "[]") as SurfaceSnapshot[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && Number.isInteger(item.revision) && typeof item.html === "string" && typeof item.css === "string")
      .map((item) => ({ ...item, js: typeof item.js === "string" ? item.js : "" }))
      .slice(-20);
  } catch {
    return [];
  }
}

function sanitizeCss(css: string): string {
  return css
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/<\/style/gi, "")
    .slice(0, 60_000);
}

function sanitizeScript(js: string): string {
  // Keeps a `</script>` inside generated code from terminating the inline tag.
  return js.replace(/<\/script/gi, "<\\/script").slice(0, 120_000);
}

function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name === "srcdoc") {
        element.removeAttribute(attr.name);
      } else if ((name === "src" || name === "href" || name === "xlink:href") && value && !value.startsWith("#") && !value.startsWith("data:") && !value.startsWith("blob:")) {
        element.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML.slice(0, 120_000);
}

function regionsInHtml(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return Array.from(doc.body.querySelectorAll("[data-ares-region]"))
    .map((node) => node.getAttribute("data-ares-region")?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 80);
}

function regionElement(root: ParentNode, target: string): Element | null {
  return Array.from(root.querySelectorAll("[data-ares-region]")).find((node) => node.getAttribute("data-ares-region") === target) ?? null;
}

interface AppliedEnvelope {
  next: SurfaceSnapshot;
  posts: unknown[];
  documentChanged: boolean;
}

function applyEnvelope(snapshot: SurfaceSnapshot, envelope: LivingSurfaceEnvelope): AppliedEnvelope {
  if (envelope.baseRevision !== snapshot.revision) {
    throw new Error(`Ares patched revision ${envelope.baseRevision}, but the surface is already at ${snapshot.revision}. Ask it to retry.`);
  }
  const posts = envelope.mutations.filter((m) => m.op === "post").map((m) => (m as { payload: unknown }).payload);
  const documentMutations = envelope.mutations.filter(isDocumentMutation);
  if (!documentMutations.length) {
    return { next: snapshot, posts, documentChanged: false };
  }
  const doc = new DOMParser().parseFromString(`<body><div id="ares-surface-root">${snapshot.html}</div></body>`, "text/html");
  const root = doc.getElementById("ares-surface-root");
  if (!root) throw new Error("surface root unavailable");
  let css = snapshot.css;
  let js = snapshot.js;
  let title = snapshot.title;
  for (const mutation of documentMutations) {
    applyMutation(root, mutation);
    if (mutation.op === "set_css") css = sanitizeCss(mutation.css);
    if (mutation.op === "set_script") js = mutation.js;
    if (mutation.op === "replace_document") {
      if (mutation.css !== undefined) css = sanitizeCss(mutation.css);
      js = mutation.js ?? "";
    }
    if (mutation.op === "set_title") title = mutation.title.slice(0, 120);
  }
  const html = sanitizeHtml(root.innerHTML);
  if (!regionsInHtml(html).length) throw new Error("A generated surface must retain at least one data-ares-region target.");
  return { next: { revision: snapshot.revision + 1, title, html, css, js }, posts, documentChanged: true };
}

function applyMutation(root: HTMLElement, mutation: LivingSurfaceMutation): void {
  if (mutation.op === "replace_document") {
    root.innerHTML = sanitizeHtml(mutation.html);
    return;
  }
  if (mutation.op === "set_css" || mutation.op === "set_title" || mutation.op === "set_script" || mutation.op === "post") return;
  const target = regionElement(root, mutation.target);
  if (!target) throw new Error(`Surface region "${mutation.target}" no longer exists.`);
  if (mutation.op === "remove_region") {
    target.remove();
    return;
  }
  const template = docFragment(sanitizeHtml(mutation.html));
  if (mutation.op === "replace_region") target.replaceChildren(template);
  else if (mutation.op === "append_region") target.append(template);
  else target.prepend(template);
}

function docFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.cloneNode(true) as DocumentFragment;
}

/* The CSP is the hard wall behind the sandbox: inline script and style may
 * run, but every network request — fetch, XHR, imports, css url(), beacons —
 * is refused, so nothing a generated surface does can leave the machine. */
const SURFACE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;";

function iframeDocument(snapshot: SurfaceSnapshot): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${SURFACE_CSP}"><style>${sanitizeCss(snapshot.css)}</style></head><body>${sanitizeHtml(snapshot.html)}<script>${sanitizeScript(BRIDGE_SCRIPT)}</script><script>${sanitizeScript(snapshot.js)}</script></body></html>`;
}

function visibleAssistantText(text: string): string {
  return text.replace(/```ares-surface[\s\S]*?```/gi, "").trim().slice(0, 2_000);
}

export function LivingSurface({ sessionId }: { sessionId: string }) {
  const native = isTauri();
  const [snapshot, setSnapshot] = useState(() => loadSnapshot(sessionId));
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [history, setHistory] = useState<SurfaceSnapshot[]>(() => loadHistory(sessionId));
  const [entered, setEntered] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const [activity, setActivity] = useState("waiting for intent");
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<SurfaceLine[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [permission, setPermission] = useState<PermissionVm | null>(null);
  const [micState, setMicState] = useState<"idle" | "connecting" | "listening" | "transcribing" | "error">("idle");
  const stt = useRef<SttHandle | null>(null);
  const turnText = useRef("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pendingPosts = useRef<unknown[]>([]);
  const faults = useRef<string[]>([]);
  // Native builds serve the document over ares-surface:// so it carries its
  // OWN sealed CSP — a srcdoc frame inherits the app CSP, whose packaged
  // style hashes and script-src 'self' strip every generated style/script.
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const prefs = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("ares.desktop.v3") ?? "{}"); } catch { return {}; }
  }, []);
  const voice = useTts({
    enabled: prefs.voiceEnabled === true,
    voice: typeof prefs.voiceId === "string" ? prefs.voiceId : DEFAULT_BUILTIN_VOICE,
    speed: typeof prefs.voiceSpeed === "number" ? prefs.voiceSpeed : 1,
  });
  const speak = voice.speak;
  const stopVoice = voice.stop;

  const addLine = useCallback((role: SurfaceLine["role"], text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setLines((current) => [...current.slice(-15), { id: crypto.randomUUID(), role, text: clean }]);
  }, []);

  const persist = useCallback((next: SurfaceSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    try { localStorage.setItem(snapshotKey(sessionId), JSON.stringify(next)); } catch { /* best effort */ }
  }, [sessionId]);

  useEffect(() => {
    try { localStorage.setItem(historyKey(sessionId), JSON.stringify(history.slice(-20))); } catch { /* best effort */ }
  }, [history, sessionId]);

  useEffect(() => {
    if (!native) return;
    let stale = false;
    invoke<string>("ares_living_surface_stage", { document: iframeDocument(snapshot) })
      .then((url) => { if (!stale) setFrameSrc(url); })
      .catch((error) => addLine("system", `Could not stage the surface: ${String(error)}`));
    return () => { stale = true; };
  }, [addLine, native, snapshot]);

  const deliverPosts = useCallback((posts: unknown[], documentChanged: boolean) => {
    if (!posts.length) return;
    if (documentChanged) {
      // The srcDoc is about to reload; hold posts for the fresh document.
      pendingPosts.current.push(...posts);
      return;
    }
    const frame = iframeRef.current?.contentWindow;
    if (!frame) {
      pendingPosts.current.push(...posts);
      return;
    }
    for (const payload of posts) frame.postMessage({ __ares: 1, type: "post", payload }, "*");
  }, []);

  const applyResponse = useCallback((text: string) => {
    const parsed = parseLivingSurfaceEnvelope(text);
    if (!parsed.envelope) {
      const visible = visibleAssistantText(text);
      addLine("system", parsed.error ?? "Ares did not return a surface patch.");
      if (visible) addLine("ares", visible);
      return;
    }
    try {
      const previous = snapshotRef.current;
      const applied = applyEnvelope(previous, parsed.envelope);
      if (applied.documentChanged) {
        setHistory((current) => [...current.slice(-19), previous]);
        persist(applied.next);
        faults.current = [];
        setActivity(`revision ${applied.next.revision} manifested`);
      } else {
        setActivity("the surface answered");
      }
      deliverPosts(applied.posts, applied.documentChanged);
      const narration = parsed.envelope.narration || visibleAssistantText(text)
        || (applied.documentChanged ? `Surface evolved to revision ${applied.next.revision}.` : "Done.");
      addLine("ares", narration);
      speak(narration);
    } catch (error) {
      addLine("system", error instanceof Error ? error.message : String(error));
    }
  }, [addLine, deliverPosts, persist, speak]);

  const send = useCallback(async (raw: string, origin: "composer" | "surface" = "composer") => {
    const request = raw.trim();
    if (!request || busyRef.current) return;
    addLine("user", request);
    setInput("");
    setPanelOpen(false);
    const goal = livingSurfacePrompt({
      request,
      revision: snapshotRef.current.revision,
      title: snapshotRef.current.title,
      regions: regionsInHtml(snapshotRef.current.html),
      htmlSummary: snapshotRef.current.html,
      jsSummary: snapshotRef.current.js,
      faults: faults.current,
      fromSurface: origin === "surface",
    });
    busyRef.current = true;
    setBusy(true);
    setActivity(origin === "surface" ? "answering inside the surface" : "opening a new possibility");
    try {
      await invoke("ares_send", { goal, sessionId, voice: false });
    } catch (error) {
      busyRef.current = false;
      setBusy(false);
      addLine("system", `Could not reach Ares: ${String(error)}`);
    }
  }, [addLine, sessionId]);

  useEffect(() => {
    document.body.dataset.livingSurface = "1";
    if (!native) {
      // Browser preview: there is no Tauri bridge to hand events over, so the
      // surface renders statically instead of spamming rejected IPC calls.
      return () => { delete document.body.dataset.livingSurface; };
    }
    // Tell Classic the trusted host actually mounted. Until this handshake,
    // the main window deliberately refuses to collapse into the pill.
    void invoke("ares_living_surface_ready", { sessionId }).catch(() => null);
    void invoke<{ token?: string; port?: number }>("ares_voice_status").then((status) => {
      if (status.token) setVoiceToken(status.token);
      if (status.port) setVoiceEndpoint(status.port);
    }).catch(() => null);
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<BufferedEvent>("ares:event-buffered", ({ payload }) => {
      if (disposed) return;
      const event = payload.event;
      if (event.sessionId !== sessionId) return;
      const type = String(event.type ?? "");
      if (type === "turn_start") {
        turnText.current = "";
        busyRef.current = true;
        setBusy(true);
        setActivity("Ares is imagining the next form");
      } else if (type === "text_delta" && typeof event.text === "string") {
        turnText.current += event.text;
      } else if (type === "tool_start") {
        setActivity(`using ${String(event.name ?? event.activityDescription ?? "a tool")}`);
      } else if (type === "tool_end") {
        setActivity("translating the work into a surface");
      } else if (type === "permission_request") {
        setPermission({
          id: String(event.id ?? ""),
          tool: String(event.toolName ?? event.name ?? "Ares tool"),
          reason: String(event.reason ?? "Ares needs permission to continue."),
        });
      } else if (type === "turn_end") {
        busyRef.current = false;
        setBusy(false);
        applyResponse(turnText.current);
        turnText.current = "";
      } else if (type === "error") {
        const detail = event.error && typeof event.error === "object" ? JSON.stringify(event.error) : String(event.error ?? "Surface turn failed");
        addLine("system", detail);
        // A terminal fault may never be followed by turn_end; never strand
        // the composer in a disabled state.
        busyRef.current = false;
        setBusy(false);
        setActivity("the last turn faulted");
      }
    }).then((un) => { if (disposed) un(); else unlisten = un; });
    return () => {
      disposed = true;
      unlisten?.();
      stopVoice();
      stt.current?.cancel();
      delete document.body.dataset.livingSurface;
    };
  }, [addLine, applyResponse, native, sessionId, stopVoice]);

  // The document runs at an opaque origin, so postMessage is its only line up.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { __ares?: number; type?: string; text?: string; message?: string } | null;
      if (!data || data.__ares !== 1) return;
      if (data.type === "send" && typeof data.text === "string") {
        void send(data.text, "surface");
      } else if (data.type === "fault" && typeof data.message === "string") {
        faults.current = [...faults.current.slice(-4), data.message];
        addLine("system", `Surface script fault: ${data.message}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [addLine, send]);

  const onFrameLoad = useCallback(() => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame) return;
    for (const payload of pendingPosts.current.splice(0)) {
      frame.postMessage({ __ares: 1, type: "post", payload }, "*");
    }
  }, []);

  const toggleMic = useCallback(async () => {
    if (stt.current) {
      setMicState("transcribing");
      const active = stt.current;
      stt.current = null;
      const text = await active.stop();
      setMicState("idle");
      if (text.trim()) void send(text);
      return;
    }
    setMicState("connecting");
    try {
      const handle = await sidecarListen((status) => setMicState(status), { auto: true });
      stt.current = handle;
      setMicState("listening");
      void handle.transcript.then((text) => {
        if (stt.current === handle) stt.current = null;
        setMicState("idle");
        if (text.trim()) void send(text);
      });
    } catch {
      stt.current = null;
      setMicState("error");
      window.setTimeout(() => setMicState("idle"), 1800);
    }
  }, [send]);

  const closeSurface = useCallback(async () => {
    stopVoice();
    if (native) await invoke("ares_living_surface_close").catch(() => getCurrentWindow().close());
    else window.close();
  }, [native, stopVoice]);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.at(-1);
      if (!previous) return current;
      persist(previous);
      addLine("system", `Returned to revision ${previous.revision}.`);
      return current.slice(0, -1);
    });
  }, [addLine, persist]);

  const reset = useCallback(() => {
    const previous = snapshotRef.current;
    setHistory((current) => [...current.slice(-19), previous]);
    persist(initialSnapshot());
    addLine("system", "The void restored. The previous surface remains available through Undo.");
  }, [addLine, persist]);

  return (
    <div className="livingHost" data-busy={busy ? "1" : "0"}>
      {!entered ? <GenesisSplash onEnter={() => setEntered(true)} /> : null}
      <header className="livingChrome" onMouseDown={(event) => {
        if (native && event.button === 0 && !(event.target as HTMLElement).closest("button,input,textarea")) void getCurrentWindow().startDragging();
      }}>
        <div className="livingIdentity"><i /><strong>ARES</strong><span>living surface</span><b>BETA</b></div>
        <div className="livingPulse"><span>{busy ? activity : snapshot.title}</span><em>r{snapshot.revision.toString().padStart(2, "0")}</em></div>
        <div className="livingChromeActions">
          <button onClick={undo} disabled={!history.length} title="Undo last evolution">↶</button>
          <button onClick={reset} title="Return to the void">VOID</button>
          <button className="livingReturn" onClick={closeSurface}>RETURN TO CLASSIC</button>
        </div>
      </header>

      {!native || frameSrc ? (
        <iframe
          ref={iframeRef}
          className="livingCanvas"
          title={snapshot.title}
          sandbox="allow-scripts allow-forms allow-pointer-lock"
          {...(native ? { src: frameSrc ?? undefined } : { srcDoc: iframeDocument(snapshot) })}
          onLoad={onFrameLoad}
        />
      ) : null}

      <div className="livingActivity" data-on={busy ? "1" : "0"}><i /><span>{activity}</span></div>

      <div className="livingConversation" data-open={panelOpen ? "1" : "0"}>
        <button className="livingTranscriptToggle" onClick={() => setPanelOpen((open) => !open)} aria-label="Toggle surface conversation">
          <span>{panelOpen ? "×" : lines.length ? lines.at(-1)?.text.slice(0, 48) : "Talk to this surface"}</span>
          {!panelOpen ? <b>{lines.length}</b> : null}
        </button>
        {panelOpen ? (
          <div className="livingTranscript">
            {lines.length ? lines.map((line) => <div key={line.id} data-role={line.role}><b>{line.role === "ares" ? "ARES" : line.role.toUpperCase()}</b><span>{line.text}</span></div>) : <p>The interface is listening. Ask it to become something useful.</p>}
          </div>
        ) : null}
      </div>

      <form className="livingComposer" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <span className="livingComposerIndex">INTENT</span>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder={busy ? activity : "Tell Ares what this world should become…"} disabled={busy} autoFocus />
        <button type="button" className="livingMic" data-state={micState} onClick={() => void toggleMic()} aria-label="Speak to Ares"><i /><i /><i /></button>
        {busy ? <button type="button" className="livingStop" onClick={() => void invoke("ares_interrupt", { sessionId })}>STOP</button> : <button type="submit" className="livingSend" disabled={!input.trim()}>EVOLVE ↗</button>}
      </form>

      {permission ? (
        <div className="livingPermission">
          <span>CAPABILITY REQUEST</span><strong>{permission.tool}</strong><p>{permission.reason}</p>
          <div><button onClick={() => { void invoke("ares_permission_response", { id: permission.id, decision: "deny" }); setPermission(null); }}>Deny</button><button onClick={() => { void invoke("ares_permission_response", { id: permission.id, decision: "allow_once" }); setPermission(null); }}>Allow once</button><button onClick={() => { void invoke("ares_permission_response", { id: permission.id, decision: "allow_always" }); setPermission(null); }}>Always</button></div>
        </div>
      ) : null}
    </div>
  );
}

function GenesisSplash({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="genesisSplash">
      <div className="genesisSplashNoise" />
      <div className="genesisScan" />
      <span className="genesisCoordinates">EXPERIMENT 01 / UNSTABLE INTELLIGENCE</span>
      <div className="genesisSigil"><i /><i /><i /></div>
      <h1><span>THIS UI</span><br />IS <em>ALIVE.</em></h1>
      <p>Beyond this screen there is no interface — only a void that becomes whatever you name. Chat rooms, games, instruments, worlds: Ares builds them live, working, around you.</p>
      <div className="genesisWarning"><b>SEALED SURFACE</b><span>Generated code runs fully sandboxed — no network, no filesystem, no system access. Ever.</span></div>
      <button onClick={onEnter}><span>ENTER THE VOID</span><b>↗</b></button>
      <small>CLASSIC ARES REMAINS IN THE PILL · ESCAPE IS ALWAYS ONE CLICK AWAY</small>
    </div>
  );
}
