/** Wire contract for Ares's self-generating, sandboxed UI surface.
 *
 * The model never receives a privileged DOM or Tauri handle. It returns this
 * small mutation language; the desktop validates it, applies it to a
 * script-enabled but opaque-origin iframe (no parent access, CSP blocks all
 * network), and relays declared intents back as ordinary Ares messages. */

export const LIVING_SURFACE_FENCE = "ares-surface";
export const LIVING_SURFACE_VERSION = 1 as const;

export type LivingSurfaceMutation =
  | { op: "replace_document"; html: string; css?: string; js?: string }
  | { op: "replace_region"; target: string; html: string }
  | { op: "append_region"; target: string; html: string }
  | { op: "prepend_region"; target: string; html: string }
  | { op: "remove_region"; target: string }
  | { op: "set_css"; css: string }
  | { op: "set_script"; js: string }
  | { op: "set_title"; title: string }
  /** Live data delivered into the RUNNING document via the `ares.onPost`
   * bridge — the surface script renders it without a reload. This is how a
   * chat room receives Ares's reply or a game receives an event. */
  | { op: "post"; payload: unknown };

export interface LivingSurfaceEnvelope {
  version: typeof LIVING_SURFACE_VERSION;
  baseRevision: number;
  narration?: string;
  mutations: LivingSurfaceMutation[];
}

export interface LivingSurfaceParseResult {
  envelope?: LivingSurfaceEnvelope;
  error?: string;
}

const MAX_MUTATIONS = 24;
const MAX_HTML_CHARS = 120_000;
const MAX_CSS_CHARS = 60_000;
const MAX_JS_CHARS = 120_000;
const MAX_POST_CHARS = 16_000;

/** True when the mutation changes the persisted document (and therefore
 * reloads the iframe); posts flow into the live script instead. */
export function isDocumentMutation(mutation: LivingSurfaceMutation): boolean {
  return mutation.op !== "post";
}

function extractFencedPayload(text: string): string | null {
  const fence = new RegExp("```" + LIVING_SURFACE_FENCE + "\\s*\\n([\\s\\S]*?)```", "i");
  const hit = text.match(fence);
  if (hit?.[1]) return hit[1].trim();
  // Models occasionally omit the fence while still following the JSON shape.
  const trimmed = text.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : null;
}

function cleanTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^[a-z0-9][a-z0-9._/-]{0,95}$/i.test(clean) ? clean : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  return value;
}

function parseMutation(value: unknown): LivingSurfaceMutation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const op = row.op;
  if (op === "replace_document") {
    const html = cleanText(row.html, MAX_HTML_CHARS);
    const css = row.css === undefined ? undefined : cleanText(row.css, MAX_CSS_CHARS);
    const js = row.js === undefined ? undefined : cleanText(row.js, MAX_JS_CHARS);
    if (html === null || css === null || js === null) return null;
    return { op, html, ...(css === undefined ? {} : { css }), ...(js === undefined ? {} : { js }) };
  }
  if (op === "set_css") {
    const css = cleanText(row.css, MAX_CSS_CHARS);
    return css === null ? null : { op, css };
  }
  if (op === "set_script") {
    const js = cleanText(row.js, MAX_JS_CHARS);
    return js === null ? null : { op, js };
  }
  if (op === "set_title") {
    const title = cleanText(row.title, 120)?.trim();
    return title ? { op, title } : null;
  }
  if (op === "post") {
    if (!("payload" in row)) return null;
    try {
      if (JSON.stringify(row.payload).length > MAX_POST_CHARS) return null;
    } catch {
      return null;
    }
    return { op, payload: row.payload };
  }
  const target = cleanTarget(row.target);
  if (!target) return null;
  if (op === "remove_region") return { op, target };
  if (op === "replace_region" || op === "append_region" || op === "prepend_region") {
    const html = cleanText(row.html, MAX_HTML_CHARS);
    return html === null ? null : { op, target, html };
  }
  return null;
}

export function parseLivingSurfaceEnvelope(text: string): LivingSurfaceParseResult {
  const payload = extractFencedPayload(text);
  if (!payload) return { error: `No \`\`\`${LIVING_SURFACE_FENCE}\` patch was found.` };
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    return { error: `The surface patch was not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!raw || typeof raw !== "object") return { error: "The surface patch must be a JSON object." };
  const row = raw as Record<string, unknown>;
  if (row.version !== LIVING_SURFACE_VERSION) return { error: `Unsupported surface protocol version ${String(row.version)}.` };
  if (!Number.isInteger(row.baseRevision) || Number(row.baseRevision) < 0) return { error: "baseRevision must be a non-negative integer." };
  const rows = Array.isArray(row.mutations) ? row.mutations : row.mutations === undefined ? [] : null;
  if (rows === null || rows.length > MAX_MUTATIONS) {
    return { error: `mutations must be an array of at most ${MAX_MUTATIONS} operations.` };
  }
  const mutations = rows.map(parseMutation);
  const bad = mutations.findIndex((item) => item === null);
  if (bad !== -1) return { error: `Mutation ${bad + 1} is invalid or exceeds the surface size limit.` };
  const narration = typeof row.narration === "string" ? row.narration.trim().slice(0, 1_200) : undefined;
  if (!mutations.length && !narration) {
    return { error: "An envelope needs at least one mutation or a narration." };
  }
  return {
    envelope: {
      version: LIVING_SURFACE_VERSION,
      baseRevision: Number(row.baseRevision),
      ...(narration ? { narration } : {}),
      mutations: mutations as LivingSurfaceMutation[],
    },
  };
}

export function livingSurfacePrompt(input: {
  request: string;
  revision: number;
  title: string;
  regions: string[];
  htmlSummary: string;
  jsSummary?: string;
  faults?: string[];
  /** True when the request came from inside the running surface (a click,
   * form, or ares.send) rather than the composer — an INHABIT signal. */
  fromSurface?: boolean;
}): string {
  const faults = (input.faults ?? []).slice(-3);
  return `[ARES LIVING SURFACE]
You control Ares's self-generating interface: a sandboxed live document you may rebuild, restyle, script, and inhabit. Use normal tools for real work when needed, but your final visible response MUST contain exactly one fenced \`\`\`${LIVING_SURFACE_FENCE} JSON object using protocol version 1.

CHOOSE THE RIGHT MODE — this matters more than anything else:
1. FORGE — the user wants something new, or a redesign. Rebuild or mutate the document. Be architecturally and visually fearless; this window is a stage, not a settings form.
2. INHABIT — the user is USING what already exists (sent a chat message, made a game move, clicked a control). DO NOT rebuild or restyle anything. Respond THROUGH the running interface: usually a single {"op":"post","payload":...} that the document's script renders live, occasionally a small append_region. A request tagged [IN-SURFACE INTERACTION] is almost always INHABIT.

FORGE QUALITY BAR — a forged surface is judged as shipped software, not a sketch:
- COMPLETE: every visible control does something real. No dead buttons, no lorem, no "coming soon", no fake screenshots-of-an-app. If you show a timeline, it scrubs; if you show a settings toggle, it changes behavior.
- FUNCTIONAL CORE FIRST: a game is playable (input, physics, collision, score, fail state, restart); a tool does its job end-to-end (real state, live updates, keyboard shortcuts, undo where natural). Build the engine, then dress it.
- AMBITIOUS CODE: write as much JavaScript as the software needs — several hundred lines is normal, not excessive. Reach for canvas, requestAnimationFrame, WebAudio, drag/pointer interactions, generated SVG. Never ship a thin mockup when a working version is possible.
- HONEST ABOUT THE SANDBOX: there is no screen capture, camera, mic, filesystem, or network in here. If the request needs one (e.g. a screen recorder), build the closest FULLY-WORKING in-sandbox experience — drive it with generated/simulated input, make everything else real (controls, timeline, export-to-data-URI), and say plainly in narration what is simulated. Never ship pretend buttons.
- ART DIRECTION: commit to one strong, specific aesthetic drawn from the request itself — never a generic gray dashboard. Deliberate type scale, confident spacing, hover/active/focus states, purposeful motion, a cohesive palette. It should look like a poster and feel like a product.
- ARRIVE WHOLE: default to a single replace_document carrying html + css + js together, so the world appears in one breath.

CAPABILITIES inside the document:
- Full inline <script> (or the "js" field) is allowed and ENCOURAGED. Build genuinely working software: game loops with keyboard/mouse input, canvas/WebGL/WebAudio, simulations, editors, chat rooms. Everything must be self-contained — the sandbox has NO network (fetch/XHR/imports/external URLs are all blocked), no parent access, no storage. Assets only as data: URIs or generated at runtime.
- Every document automatically gets a bridge object \`ares\`:
    ares.send(text)   → delivers user intent to Ares (arrives as your next request)
    ares.onPost(fn)   → receives every {"op":"post"} payload live, WITHOUT a reload
  Wire interactive surfaces through it: a chat room renders incoming replies in ares.onPost and sends outgoing messages with ares.send; you then answer with post ops only, and the room just works. Elements with data-ares-action="..." auto-send on click; forms with data-ares-action auto-send their field values on submit.
- LOCAL FIRST — the most common failure is over-wiring. Controls that only affect the surface itself (sliders, toggles, FPS/quality settings, play/pause, tabs, game input, filters) are handled ENTIRELY by the document's own script and never touch ares.send. Route through ares.send ONLY what genuinely needs Ares's intelligence: messages addressed to Ares, "generate/answer/decide" intents. A settings change that round-trips to Ares is a bug.
- Document mutations reload the document and RESET all script state. Posts do not. Once something is alive, prefer posts.

Current surface:
- revision: ${input.revision}
- title: ${input.title}
- addressable regions: ${input.regions.join(", ") || "none — use replace_document"}${faults.length ? `\n- recent script faults to fix if you touch the document: ${faults.join(" | ")}` : ""}
- HTML snapshot:
${input.htmlSummary.slice(0, 14_000)}
- script snapshot:
${(input.jsSummary ?? "").slice(0, 10_000) || "(no document script yet)"}

Contract:
{
  "version": 1,
  "baseRevision": ${input.revision},
  "narration": "one short natural sentence Ares may speak",
  "mutations": [
    {"op":"replace_document","html":"<main data-ares-region=\\"main\\">...</main>","css":"...","js":"..."},
    {"op":"replace_region","target":"main","html":"..."},
    {"op":"append_region","target":"feed","html":"..."},
    {"op":"set_css","css":"..."},
    {"op":"set_script","js":"..."},
    {"op":"set_title","title":"..."},
    {"op":"post","payload":{"any":"json the document script understands"}}
  ]
}
Rules: an envelope with ONLY post ops (or none, plus narration) is valid and is the correct INHABIT response. Every document keeps at least one data-ares-region. Never emit markdown outside the fence, never reference external URLs, and make forged interfaces genuinely task-specific, functional, and breathtaking.

${input.fromSurface ? "[IN-SURFACE INTERACTION] The user is interacting WITH the running interface — this is NOT a build request. Reply through the surface: post ops its script renders (or a small append_region). replace_document / set_css / set_script are FORBIDDEN here unless the interaction is, in its own words, a request to redesign.\n" : ""}USER REQUEST:
${input.request.trim()}`;
}
