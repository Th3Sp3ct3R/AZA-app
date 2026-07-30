// Playwright adapter — the real engine, opt-in (Ares v5 / O6).
//
// Headless, sandboxable, daemon-capable — the only browser stack that works
// when the terminal is closed (which the Chrome MCP, being interactively
// authenticated, cannot). Loaded by DYNAMIC import so this package builds and
// the MockBrowser works with zero browser dependency. To enable the real engine:
//
//   pnpm add -w playwright && npx playwright install chromium
//
// Internals are loosely typed on purpose (the dependency may be absent at build
// time); the returned object is checked against the BrowserConnector contract.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessibilityNode, BrowserConnector } from "./types.js";
import { runChallengeHandoff, type HumanCheckHandler } from "./challenge.js";

export interface PlaywrightOptions {
  headless?: boolean;
  /** Attach to an already-debuggable Chromium only; never launch a fallback. */
  attachOnly?: boolean;
  /** Per-call CDP endpoint, used by the Browser handshake action. */
  cdpUrl?: string;
  /** Called when a CAPTCHA/Cloudflare wall is hit — the human-handoff Gate.
   *  Absent → challenges are detected but navigation just proceeds (legacy). */
  onChallenge?: HumanCheckHandler;
  /** Live view: called with a base64 JPEG every time the page visibly changes
   *  (cursor glide frames, post-click). The daemon streams these into the Ares UI
   *  so the owner WATCHES Ares browse — its own embedded browser, no popup. */
  onFrame?: (jpegBase64: string) => void;
  /** Human-watchable pacing: ms the cursor takes to glide to a target (default
   *  420). Larger = slower/more deliberate so it's easy to follow. */
  paceMs?: number;
}

export function findInstalledChromium(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env["PROGRAMFILES(X86)"]
            ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
            : "",
          process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
            : "",
          process.env["PROGRAMFILES(X86)"]
            ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
            : "",
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
            : "",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** One browser-launch strategy: extra options merged into launchPersistentContext. */
export interface LaunchAttempt {
  label: string;
  options: { executablePath?: string; channel?: string };
}

/**
 * Ordered launch strategies, best fingerprint first, so the browser actually
 * starts on a real user's machine instead of demanding `playwright install`:
 *   1. the user's real Edge/Chrome by detected path (best anti-bot fingerprint),
 *   2/3. Playwright's channel lookup for msedge / chrome — finds installs the
 *        hardcoded path probe missed (per-user dirs, non-standard locations),
 *   4. Playwright's bundled Chromium — the floor that works whenever a browsers
 *      dir is present (PLAYWRIGHT_BROWSERS_PATH, e.g. the shipped Tauri runtime).
 * The first one that launches wins.
 */
export function browserLaunchAttempts(executablePath: string | undefined): LaunchAttempt[] {
  const attempts: LaunchAttempt[] = [];
  if (executablePath) attempts.push({ label: `executable:${executablePath}`, options: { executablePath } });
  attempts.push({ label: "channel:msedge", options: { channel: "msedge" } });
  attempts.push({ label: "channel:chrome", options: { channel: "chrome" } });
  attempts.push({ label: "bundled-chromium", options: {} });
  return attempts;
}

/** Parse Playwright's aria snapshot YAML (lines like `- button "Submit"`) into
 *  the {role, name, selector} nodes the connector contract uses. */
function parseAriaSnapshot(yaml: string): AccessibilityNode[] {
  const out: AccessibilityNode[] = [];
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^-\s+([a-z]+)(?:\s+"([^"]*)")?/i);
    if (!m) continue;
    const role = m[1];
    const name = m[2];
    out.push({ role, name, selector: name ? `${role}:${name}` : role });
  }
  return out;
}

/** A page plus how to release it — close() disconnects a CDP attach (the user's
 *  real browser keeps running) or closes a Playwright-launched context. */
export interface AcquiredPage {
  page: any;
  close: () => Promise<void>;
  /** Which strategy won, for diagnostics (e.g. "cdp:http://127.0.0.1:9222" or "launch:channel:msedge"). */
  strategy: string;
}

export interface AcquireOptions {
  /** Explicit CDP endpoint (ARES_BROWSER_CDP_URL). Tried first when set. */
  cdpUrl?: string;
  /** Fail after CDP probes instead of launching a separate browser. */
  requireCdp?: boolean;
  /** Localhost CDP auto-discovery. createPlaywrightBrowser enables it unless ARES_BROWSER_CDP_DISCOVERY=0. */
  discovery?: boolean;
  /** Ports to probe when discovery is on. Defaults to [9222]. */
  discoveryPorts?: number[];
  executablePath?: string;
  headless: boolean;
  userDataDir: string;
  viewport: { width: number; height: number };
}

/** Parse "9222,9223" → [9222, 9223]; undefined/empty → undefined. */
export function parseCdpPorts(raw: string | undefined): number[] | undefined {
  if (!raw) return undefined;
  const ports = raw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65_535);
  return ports.length ? ports : undefined;
}

/**
 * Acquire a usable page by the configured strategy order:
 *   1. explicit CDP endpoint (attach to the user's REAL logged-in browser),
 *   2. opt-in localhost CDP discovery (gated — never grabs a random browser by default),
 *   3-6. launch a persistent-profile browser (detected exe → msedge → chrome → bundled).
 * Attaching reuses the existing context/page (real cookies, extensions, sessions);
 * close() only DISCONNECTS an attached browser, it never kills it.
 * Injectable `pw` (the Playwright module) so the ordering is unit-testable.
 */
export async function acquireBrowserPage(pw: any, opts: AcquireOptions): Promise<AcquiredPage> {
  const cdpTargets: string[] = [];
  if (opts.cdpUrl) cdpTargets.push(opts.cdpUrl);
  if (opts.discovery) {
    for (const port of opts.discoveryPorts ?? [9222]) cdpTargets.push(`http://127.0.0.1:${port}`);
  }
  for (const url of cdpTargets) {
    try {
      const browser = await pw.chromium.connectOverCDP(url, { timeout: 5_000 });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      // close() on a CDP-connected browser disconnects Playwright; the real
      // browser the user launched keeps running.
      return { page, strategy: `cdp:${url}`, close: async () => { await browser.close(); } };
    } catch {
      // Unreachable / refused → try the next target, then fall back to launching.
    }
  }

  if (opts.requireCdp) {
    throw new Error(
      "BROWSER_ATTACH_UNAVAILABLE: no debuggable Chromium endpoint answered. An already-open normal Chrome/Edge cannot be silently hijacked. " +
        "Start an Ares-controlled browser profile with remote debugging, or install an explicit owner-approved extension bridge.",
    );
  }

  let lastError: unknown;
  const tryLaunchLadder = async (userDataDir: string, label: string): Promise<AcquiredPage | null> => {
    for (const attempt of browserLaunchAttempts(opts.executablePath)) {
      try {
        const context = await pw.chromium.launchPersistentContext(userDataDir, {
          headless: opts.headless,
          viewport: opts.viewport,
          // Real-browser posture so sites (esp. video — YouTube/Netflix) actually
          // work instead of throwing "Something went wrong":
          //  • chromiumSandbox:true   → drops the "--no-sandbox unsupported flag"
          //    banner and restores the normal, sandboxed media pipeline.
          //  • ignoreDefaultArgs      → strip Playwright's "--enable-automation",
          //    the flag YouTube's player checks to refuse playback.
          //  • AutomationControlled   → hide navigator.webdriver so anti-bot and
          //    DRM (Widevine) treat the session as a real human's browser.
          chromiumSandbox: true,
          ignoreDefaultArgs: ["--enable-automation"],
          args: ["--disable-blink-features=AutomationControlled"],
          ...attempt.options,
        });
        const page = context.pages()[0] ?? (await context.newPage());
        return { page, strategy: `launch:${attempt.label}${label}`, close: async () => { await context.close(); } };
      } catch (error) {
        lastError = error;
      }
    }
    return null;
  };
  const withProfile = await tryLaunchLadder(opts.userDataDir, "");
  if (withProfile) return withProfile;
  // Every strategy failing IDENTICALLY usually isn't four missing browsers —
  // it's the shared persistent profile (SingletonLock from a crashed run, a
  // corrupt dir, or the user's real Edge already holding it). A fresh throwaway
  // profile loses cookies but turns "BROWSER_UNAVAILABLE, 5 tool failures per
  // session" into a working browser (recurring failure across user machines).
  const freshDir = path.join(os.tmpdir(), `ares-browser-fresh-${process.pid}-${Date.now()}`);
  const fresh = await tryLaunchLadder(freshDir, ":fresh-profile");
  if (fresh) return fresh;
  throw new Error(
    `BROWSER_UNAVAILABLE: no CDP endpoint reachable and no Edge/Chrome/Chromium runtime could launch (tried the persistent profile AND a fresh temp profile). ` +
      `Likely causes: no Chrome/Edge installed and no bundled Chromium (run \`npx playwright install chromium\`), or an antivirus blocking launches. Last error: ${String(lastError)}`,
  );
}

export async function createPlaywrightBrowser(opts: PlaywrightOptions = {}): Promise<BrowserConnector> {
  const moduleName: string = "playwright";
  let pw: any;
  try {
    pw = await import(moduleName);
  } catch {
    // Terminal, non-actionable message ON PURPOSE: the model must NOT try to
    // "install" anything (that loops for minutes outside a dev checkout). It
    // should switch tools. Surfaced verbatim to the agent.
    throw new Error(
      "BROWSER_UNAVAILABLE: the headless browser is not available in this build. Do not attempt to install it. Use WebFetch to read page text, or ImageSearch to get image URLs, instead.",
    );
  }

  // A PERSISTENT profile under ~/.ares — durable cookies/logins survive across
  // sessions and daemon restarts (so "log into my accounts / manage dashboards"
  // is possible), and pointing at the user's real Chrome/Edge build gives a
  // genuine fingerprint that passes most anti-bot checks a stock headless fails.
  const userDataDir = process.env.ARES_HOME
    ? path.join(process.env.ARES_HOME, "browser-profile")
    : path.join(os.tmpdir(), "ares-browser-profile");
  // Prefer attaching to the user's REAL running browser (their logged-in profile,
  // cookies, extensions — the thing that actually beats Cloudflare/anti-bot and
  // gives real codecs/DRM for video). Discovery now defaults ON: if a Chrome is
  // listening on the debug port (started with --remote-debugging-port=9222) Ares
  // uses THAT — a real, logged-in, human-fingerprinted session — and only launches
  // its own persistent-profile browser when none is found. Kill switch:
  // ARES_BROWSER_CDP_DISCOVERY=0. Explicit ARES_BROWSER_CDP_URL still wins.
  const acquired = await acquireBrowserPage(pw, {
    cdpUrl: opts.cdpUrl?.trim() || process.env.ARES_BROWSER_CDP_URL?.trim() || undefined,
    requireCdp: opts.attachOnly,
    discovery: process.env.ARES_BROWSER_CDP_DISCOVERY !== "0",
    discoveryPorts: parseCdpPorts(process.env.ARES_BROWSER_CDP_PORTS),
    executablePath: findInstalledChromium(),
    headless: opts.headless ?? true,
    userDataDir,
    viewport: { width: 1280, height: 800 },
  });
  let page = acquired.page;

  // ── console capture: read errors/logs after an interaction, like a dev tools ──
  const consoleBuffer: Array<{ type: string; text: string; at: string }> = [];
  const pushLog = (type: string, text: string) => {
    consoleBuffer.push({ type, text: String(text).slice(0, 2000), at: new Date().toISOString() });
    if (consoleBuffer.length > 600) consoleBuffer.shift();
  };
  const boundPages = new WeakSet<object>();
  const bindConsole = (target: any) => {
    if (!target || boundPages.has(target)) return;
    try {
      target.on("console", (m: any) => pushLog(m.type?.() ?? "log", m.text?.() ?? ""));
      target.on("pageerror", (e: any) => pushLog("error", e?.message ?? String(e)));
      target.on("requestfailed", (r: any) => pushLog("warn", `request failed: ${r?.url?.() ?? ""}`));
      boundPages.add(target);
    } catch {
      // older Playwright event shapes — capture is best-effort
    }
  };
  bindConsole(page);

  // ── Continuous live stream (CDP screencast) ──────────────────────────────
  // The old "live" view only emitted a JPEG around discrete cursor/click/nav
  // actions, so between actions it froze on a stale frame and read as "just
  // screenshots, bugged out". A CDP screencast pushes a real frame every time
  // the page REPAINTS (scroll, animation, video, load, the cursor glide) — the
  // genuine live view. Chromium-only; on any failure we silently keep the
  // discrete emitFrame() path as the fallback. ARES_BROWSER_SCREENCAST=0 opts out.
  let screencast: { session: any; stop: () => Promise<void> } | null = null;
  const startScreencast = async (): Promise<void> => {
    if (screencast || !opts.onFrame || process.env.ARES_BROWSER_SCREENCAST === "0") return;
    try {
      const session = await page.context().newCDPSession(page);
      session.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
        try {
          opts.onFrame?.(frame.data); // already base64 jpeg
        } finally {
          // MUST ack or Chromium stops sending frames after a few in flight.
          session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
        }
      });
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: Number(process.env.ARES_BROWSER_SCREENCAST_QUALITY) || 70,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      screencast = {
        session,
        stop: async () => {
          try { await session.send("Page.stopScreencast"); } catch { /* ignore */ }
          try { await session.detach(); } catch { /* ignore */ }
        },
      };
    } catch {
      // Non-Chromium engine or CDP unavailable — discrete emitFrame() carries the
      // stream instead. Never let a cosmetic screencast failure break the tool.
      screencast = null;
    }
  };
  // Kick it off in the background; the first navigate/action still emits frames
  // while this warms up.
  void startScreencast();

  // ── human-like cursor: the REAL pointer moves along a curved, eased path so
  // hover states fire and the motion reads as a person, not a robot. The owner
  // watches it travel, aim, press, and click — streamed frame by frame. ──
  // 200ms glides read as human but don't turn a 10-field form into a minute of
  // watching the cursor float (the old 460ms did). ARES_BROWSER_PACE_MS overrides.
  const paceMs = Math.max(120, opts.paceMs ?? 200);
  const viewW = 1280, viewH = 800;
  let curX = viewW / 2, curY = viewH / 2; // tracked cursor position (continuous between actions)
  const sleep = (ms: number) => page.waitForTimeout?.(ms).catch(() => undefined) ?? Promise.resolve();
  const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const CURSOR_JS = `(() => {
    if (window.__aresCursorReady) return;
    window.__aresCursorReady = true;
    const c = document.createElement('div');
    c.id = '__ares_cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:transform 60ms linear,filter 90ms ease;will-change:transform;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55));';
    c.innerHTML = '<svg width="24" height="24" viewBox="0 0 26 26"><path d="M3,2 L3,20 L8,15 L11,23 L14,22 L11,14 L18,14 Z" fill="#fff" stroke="#d6402e" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const st = document.createElement('style');
    st.textContent = '@keyframes __aresRip{0%{transform:translate(-50%,-50%) scale(.2);opacity:.95}100%{transform:translate(-50%,-50%) scale(2);opacity:0}}';
    document.documentElement.appendChild(st);
    let px = -100, py = -100, scale = 1;
    const apply = () => { c.style.transform = 'translate(' + (px - 3) + 'px,' + (py - 2) + 'px) scale(' + scale + ')'; };
    window.__aresMove = (x, y) => { px = x; py = y; apply(); };
    window.__aresPress = (down) => { scale = down ? 0.78 : 1; c.style.filter = down ? 'drop-shadow(0 0 6px #d6402e)' : 'drop-shadow(0 2px 5px rgba(0,0,0,.55))'; apply(); };
    window.__aresRipple = (x, y) => {
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;width:34px;height:34px;border:2.5px solid #d6402e;border-radius:50%;z-index:2147483646;pointer-events:none;animation:__aresRip .5s ease-out forwards;';
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 560);
    };
  })()`;
  async function ensureCursor(): Promise<void> {
    try { await page.evaluate(CURSOR_JS); } catch { /* page not ready — skip cosmetics */ }
  }
  async function emitFrame(): Promise<void> {
    if (!opts.onFrame) return;
    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 55 });
      opts.onFrame(Buffer.from(buf).toString("base64"));
    } catch { /* frame is best-effort */ }
  }
  async function syncCursor(x: number, y: number): Promise<void> {
    try { await page.evaluate(([px, py]: number[]) => (window as any).__aresMove?.(px, py), [x, y]); } catch { /* ignore */ }
  }

  // Move the REAL mouse + visual cursor from where it is to (tx,ty) along a gently
  // curved, ease-in-out path. Real movement = hover/:hover effects fire, exactly
  // like a person sweeping to a control. Frames stream throughout.
  async function humanMoveTo(tx: number, ty: number): Promise<void> {
    await ensureCursor();
    const sx = curX, sy = curY;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) { curX = tx; curY = ty; await syncCursor(tx, ty); return; }
    // perpendicular bow so the path arcs instead of running dead-straight
    const bow = Math.min(dist * 0.16, 70) * (Math.random() < 0.5 ? 1 : -1);
    const mx = (sx + tx) / 2 - (dy / dist) * bow;
    const my = (sy + ty) / 2 + (dx / dist) * bow;
    const steps = Math.max(14, Math.min(44, Math.round(dist / 9)));
    const frameEvery = Math.max(1, Math.round(steps / (opts.onFrame ? 9 : steps)));
    for (let i = 1; i <= steps; i++) {
      const t = easeInOut(i / steps);
      const u = 1 - t;
      const x = u * u * sx + 2 * u * t * mx + t * t * tx;
      const y = u * u * sy + 2 * u * t * my + t * t * ty;
      try { await page.mouse.move(x, y); } catch { /* ignore */ }
      await syncCursor(x, y);
      curX = x; curY = y;
      if (opts.onFrame && i % frameEvery === 0) await emitFrame();
      await sleep(paceMs / steps);
    }
    curX = tx; curY = ty;
  }
  async function pressCursor(): Promise<void> {
    try { await page.evaluate(() => (window as any).__aresPress?.(true)); } catch { /* ignore */ }
    await emitFrame();
    await sleep(90);
    try { await page.evaluate(() => (window as any).__aresPress?.(false)); } catch { /* ignore */ }
  }
  async function rippleAt(x: number, y: number): Promise<void> {
    try { await page.evaluate(([px, py]: number[]) => (window as any).__aresRipple?.(px, py), [x, y]); } catch { /* ignore */ }
    await emitFrame();
  }

  // Sweep to a locator like a person: scroll it into view, arc the cursor over,
  // pause to "aim", dip a press, click, settle.
  async function actOnLocator(locator: any, act: (l: any) => Promise<void>): Promise<void> {
    try { await locator.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch { /* ignore */ }
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      // aim slightly off dead-center, like a real hand
      const jitterX = (Math.random() - 0.5) * Math.min(box.width * 0.3, 8);
      const jitterY = (Math.random() - 0.5) * Math.min(box.height * 0.3, 6);
      const cx = box.x + box.width / 2 + jitterX, cy = box.y + box.height / 2 + jitterY;
      await humanMoveTo(cx, cy);
      await sleep(70);             // a beat to aim
      await emitFrame();           // show the hover state
      await pressCursor();         // press dip
      await rippleAt(cx, cy);
    }
    await act(locator);
    await sleep(140);              // let the result paint
    await emitFrame();
  }

  // Type character-by-character at human cadence so the owner watches text appear.
  async function typeHuman(locator: any, value: string): Promise<void> {
    await actOnLocator(locator, (l) => l.click({ timeout: 5_000 }).catch(() => undefined));
    try { await locator.fill(""); } catch { /* ignore */ }
    const chunks = value.match(/.{1,6}/gs) ?? [value];
    for (const ch of chunks) {
      try { await locator.pressSequentially(ch, { delay: 28 }); } catch { try { await locator.type(ch, { delay: 28 }); } catch { /* ignore */ } }
      await emitFrame();
    }
  }

  const flatten = (node: any, out: AccessibilityNode[] = []): AccessibilityNode[] => {
    if (node && typeof node.role === "string") {
      out.push({ role: node.role, name: node.name, selector: node.name ? `${node.role}:${node.name}` : node.role });
    }
    for (const child of node?.children ?? []) flatten(child, out);
    return out;
  };

  /**
   * After a navigation, run the CAPTCHA/Cloudflare handoff loop (testable, in
   * challenge.ts). Best-effort: any error here never breaks the navigation.
   */
  async function maybeHandleChallenge(): Promise<void> {
    if (!opts.onChallenge) return;
    await runChallengeHandoff({
      onChallenge: opts.onChallenge,
      getSurface: async () => ({
        url: page.url(),
        title: await page.title().catch(() => ""),
        html: await page.content().catch(() => ""),
      }),
      settle: async () => {
        await page.waitForTimeout?.(500).catch(() => undefined);
      },
    }).catch(() => undefined);
  }

  return {
    name: "playwright",
    strategy: acquired.strategy,
    async tabs() {
      const pages = page.context().pages();
      return Promise.all(pages.map(async (candidate: any, index: number) => ({
        index,
        url: candidate.url(),
        title: await candidate.title().catch(() => ""),
        active: candidate === page,
      })));
    },
    async attachToExisting(query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return false;
      let requested: URL | null = null;
      try { requested = new URL(query.includes("://") ? query : `https://${query}`); } catch { /* text query */ }
      const pages = page.context().pages();
      const candidates = await Promise.all(pages.map(async (candidate: any) => {
        const url = candidate.url();
        const title = await candidate.title().catch(() => "");
        let score = 0;
        if (url.toLowerCase() === needle) score = 100;
        else if (url.toLowerCase().includes(needle) || title.toLowerCase().includes(needle)) score = 80;
        if (requested) {
          try {
            const current = new URL(url);
            if (current.origin === requested.origin) score = Math.max(score, 70);
            else if (current.hostname === requested.hostname) score = Math.max(score, 60);
          } catch { /* ignore non-web pages */ }
        }
        return { candidate, score };
      }));
      const best = candidates.sort((a, b) => b.score - a.score)[0];
      if (!best || best.score === 0) return false;
      if (best.candidate !== page) {
        if (screencast) { await screencast.stop().catch(() => undefined); screencast = null; }
        page = best.candidate;
        bindConsole(page);
        curX = viewW / 2;
        curY = viewH / 2;
        await page.bringToFront().catch(() => undefined);
        await ensureCursor();
        void startScreencast();
      }
      return true;
    },
    async navigate(url) {
      // Bounded waits — a stock 30s default means every miss is a half-minute hang.
      await page.goto(url, { timeout: 15_000, waitUntil: "domcontentloaded" });
      await maybeHandleChallenge();
      await ensureCursor();
      // park the pointer mid-screen so it's visible before the first move
      try { await page.mouse.move(curX, curY); } catch { /* ignore */ }
      await syncCursor(curX, curY);
      await emitFrame();
      return { url: page.url(), title: await page.title() };
    },
    async accessibilityTree() {
      // page.accessibility was removed in newer Playwright — calling .snapshot()
      // on it threw "Cannot read properties of undefined (reading 'snapshot')".
      // Use it when present, else the modern aria snapshot (built for agents).
      if (page.accessibility?.snapshot) {
        const snapshot = await page.accessibility.snapshot().catch(() => null);
        if (snapshot) return flatten(snapshot);
      }
      const yaml: string = await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => "");
      return parseAriaSnapshot(yaml);
    },
    async fillByLabel(label, value) {
      await typeHuman(page.getByLabel(label).first(), value);
    },
    async clickByRole(role, name) {
      const locator = page.getByRole(role, { name }).first();
      await actOnLocator(locator, async (l) => {
        try {
          await l.click({ timeout: 5_000 });
        } catch (err) {
          const count = await page.getByRole(role, { name }).count().catch(() => 0);
          if (count > 1) await page.getByRole(role, { name }).first().click({ timeout: 5_000 });
          else throw err;
        }
      });
    },
    async clickByText(query) {
      // Try CSS selector first (precise), else fall to visible-text matching.
      let loc: any;
      const looksLikeSelector = /[.#\[>:]/.test(query) || /^[a-z][a-z0-9-]*$/i.test(query);
      if (looksLikeSelector) {
        const cand = page.locator(query).first();
        if (await cand.count().catch(() => 0)) loc = cand;
      }
      if (!loc) loc = page.getByText(query, { exact: false }).first();
      if (!(await loc.count().catch(() => 0))) loc = page.locator(`text=${query}`).first();
      await actOnLocator(loc, (l) => l.click({ timeout: 5_000 }));
    },
    async fillBySelector(selector, value) {
      await typeHuman(page.locator(selector).first(), value);
    },
    async consoleLogs(o) {
      let logs = consoleBuffer.slice();
      if (o?.onlyErrors) logs = logs.filter((e) => e.type === "error" || e.type === "warning" || e.type === "warn");
      const limit = o?.limit ?? 50;
      return logs.slice(-limit);
    },
    async evaluate(js) {
      // Run an expression/IIFE in the page; return the JSON-serializable result.
      return page.evaluate(`(() => { return (${js}); })()`).catch(async () =>
        // not an expression? run as a statement body.
        page.evaluate(`(() => { ${js} })()`),
      );
    },
    async screenshot() {
      const buffer: Buffer = await page.screenshot();
      return { format: "png", bytes: buffer.toString("base64") };
    },
    async state() {
      return { url: page.url(), title: await page.title() };
    },
    async close() {
      if (screencast) { await screencast.stop().catch(() => undefined); screencast = null; }
      await acquired.close();
    },
  };
}
