// Extracted from entry.ts — browserBridge.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { stdout } from "node:process";
import { buildTool } from "@ares/tools";
import { z } from "zod";
import { loadUiSettings, type UiSettings } from "../uiSettings.js";
import { TrustGovernor } from "@ares/operator";
import { MemoryStore } from "@ares/mind";
import { Filmstrip, browserActionEffect, clickEffect, createPlaywrightBrowser, fillEffect, navigateEffect, challengePrompt, type BrowserConnector, type HumanCheckHandler } from "@ares/connectors";
import { Budget, KillSwitch, Ledger, ownerLeash, runEffect, type ApprovalDecision, type RailsContext, type BudgetLimits } from "@ares/effects";
import { CliRuntimeContext } from "./runtime.js";
import { BrowserBridgeServer, ExtensionBrowserConnector } from "@ares/browser-extension-connector";

// ── Embedded-browser bridge: the daemon ⇄ UI request/response channel that lets
// the agent drive Ares's OWN in-app browser (the same-origin iframe in the Forge).
// exec() emits a webview_cmd event to stdout (→ UI), and awaits the matching
// webview_result command the UI sends back. No Playwright — the page renders and
// runs IN the Ares window.
interface WebviewResult { ok: boolean; result?: unknown; error?: string; }

class EmbeddedBrowserBridge {
  private readonly pending = new Map<string, (r: WebviewResult) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  emit: ((obj: Record<string, unknown>) => void) | null = null;
  get attached(): boolean { return this.emit !== null; }
  exec(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<WebviewResult> {
    if (!this.emit) return Promise.resolve({ ok: false, error: "embedded browser unavailable — open the Ares desktop window" });
    const cmdId = `wv_${process.pid}_${++this.seq}`;
    return new Promise<WebviewResult>((resolve) => {
      this.pending.set(cmdId, resolve);
      this.timers.set(cmdId, setTimeout(() => {
        this.pending.delete(cmdId); this.timers.delete(cmdId);
        resolve({ ok: false, error: "embedded browser timed out" });
      }, timeoutMs));
      this.emit!({ type: "webview_cmd", cmdId, op, ...args });
    });
  }
  resolve(cmdId: string, payload: WebviewResult): void {
    const r = this.pending.get(cmdId);
    if (!r) return;
    const t = this.timers.get(cmdId);
    if (t) clearTimeout(t);
    this.pending.delete(cmdId); this.timers.delete(cmdId);
    r(payload);
  }
}

export const embeddedBridge = new EmbeddedBrowserBridge();

// One authenticated loopback server belongs to the daemon process. Browser
// tool instances are per conversation, but each can create its own lightweight
// tab connector over this shared transport.
let extensionBridge: BrowserBridgeServer | null = null;

export function setExtensionBrowserBridge(bridge: BrowserBridgeServer | null): void {
  extensionBridge = bridge;
}

const browserStep = z
  .object({
    action: z.enum(["open", "click", "click_text", "fill", "fill_selector", "eval"]),
    url: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    value: z.string().optional(),
    query: z.string().optional(),
    selector: z.string().optional(),
    js: z.string().optional(),
  })
  .strict();

const browserInput = z
  .object({
    action: z
      .enum(["open", "act", "handshake", "tabs", "attach", "preview", "tree", "screenshot", "fill", "fill_selector", "click", "click_text", "console", "eval", "state", "close", "filmstrip"])
      .describe(
        "Browser action. DOM-first web actions: open/tree/fill/click/screenshot/state/close. " +
        "PREVIEW & VERIFY (drives a VISIBLE browser with an animated cursor so the owner watches Ares test the UI): " +
        "'preview' opens a URL visibly; 'click_text' clicks a button/link/tab by visible text or CSS selector; " +
        "'fill_selector' types into a CSS selector; 'console' reads console logs/errors after acting; " +
        "'eval' runs JS in the page to inspect state or call a function. " +
        "Use 'handshake' to attach ONLY to an already-open CDP-enabled Chrome/Edge without launching a replacement. " +
        "Use 'act' with steps for a complete multi-control job; it executes the sequence and returns one final visual verification instead of burning a model round-trip per click.",
      ),
    url: z.string().optional().describe("URL for open/preview (e.g. http://localhost:1420)."),
    label: z.string().optional().describe("Accessible label for fill."),
    value: z.string().optional().describe("Value for fill / fill_selector."),
    role: z.string().optional().describe("ARIA role for click."),
    name: z.string().optional().describe("Accessible name for click."),
    query: z.string().optional().describe("Visible text or CSS selector for click_text."),
    selector: z.string().optional().describe("CSS selector for fill_selector."),
    js: z.string().optional().describe("JS expression/IIFE to run in the page for eval (e.g. 'document.querySelectorAll(\".item\").length')."),
    onlyErrors: z.boolean().optional().describe("console: return only errors/warnings."),
    engine: z.enum(["playwright", "embedded"]).optional().describe(
      "Which browser: 'playwright' (default) drives a streamed headless browser for ANY url (localhost dev servers, real web). " +
      "'embedded' renders self-contained HTML you pass via `html` INSIDE the Ares window (same-origin) and drives it directly — use this to test the apps/games/UIs YOU build as a single .html, with a real visible cursor and zero popup. " +
      "Embedded actions: preview(html) to load, then click_text/fill_selector/eval/console/screenshot(snapshot).",
    ),
    html: z.string().optional().describe("Self-contained HTML to render in the embedded browser (engine:'embedded', action:'preview')."),
    headless: z.boolean().optional().describe("Run headless (invisible). DEFAULT true for plain web tasks — the owner does NOT want to watch navigation. The 'preview' action overrides this to VISIBLE so the owner can watch the UI test. Pass false to watch any action."),
    note: z.string().optional().describe("Optional note attached to screenshot frames."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum tree/filmstrip/console entries returned."),
    steps: z.array(browserStep).min(1).max(24).optional().describe("act: ordered DOM-first actions to execute as one transaction, followed by one screenshot and page-state verification."),
    allowRepeat: z.boolean().optional().describe("Permit an intentional repeat of a recently committed click/act. Default false prevents accidental duplicate sends/submits."),
  })
  .strict();

interface BrowserToolOutput {
  action: string;
  status: string;
  result?: unknown;
  /** CDP attachment or Ares-owned launch strategy, when Playwright exposes it. */
  browserStrategy?: string;
  /** Loud warning when a rails-gated action did NOT commit (staged/denied). */
  note?: string;
  filmstripDir: string;
}

export function makeBrowserTool(
  context: CliRuntimeContext,
  createBrowser: typeof createPlaywrightBrowser = createPlaywrightBrowser,
) {
  let browser: BrowserConnector | null = null;
  let filmstrip: Filmstrip | null = null;
  let sequence = 0;
  const recentOutwardActions = new Map<string, number>();
  // Set per-call to the current turn's progress emitter, so the persistent
  // browser streams its live frames into THIS turn's UI panel.
  let frameSink: ((jpegBase64: string) => void) | null = null;
  // Set per-call to the current turn's permission prompt, so the PERSISTENT
  // browser's challenge handler (bound once at creation) reaches THIS turn's
  // approval card instead of only the garrison gateway.
  let promptApprover: RailsContext["requestApproval"] | null = null;

  const ensureBrowser = async (headless?: boolean, attachOnly = false, cdpUrl?: string): Promise<BrowserConnector> => {
    if (browser?.strategy === "extension:native-messaging" && !extensionBridge?.connected()) {
      await browser.close().catch(() => undefined);
      browser = null;
    }
    if (browser) {
      try {
        await browser.state();
      } catch (error) {
        // Users routinely close the visible preview window. Retaining that dead
        // connector made every subsequent action fail with "Target page,
        // context or browser has been closed". Re-acquire transparently on the
        // next call; unrelated state errors still surface honestly.
        if (!isClosedBrowserError(error)) throw error;
        await browser.close().catch(() => undefined);
        browser = null;
      }
      if (browser && attachOnly && !browser.strategy?.startsWith("cdp:")) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
    }
    if (!browser && extensionBridge?.connected() && attachOnly) {
      browser = new ExtensionBrowserConnector(extensionBridge);
    }
    if (!browser) {
      // CAPTCHA handoff: a challenge surfaces through the SAME Gate as approvals
      // (so it renders on Telegram/UI). The owner solves it in their CDP-attached
      // Chrome and approves → "solved"; deny → "skip". The approver is resolved
      // at FIRE time: garrison gateway first, else the current turn's permission
      // card (promptApprover). Neither wired (plain CLI) → challenges are
      // detected but navigation just proceeds, as before.
      const onChallenge: HumanCheckHandler = async (info) => {
        const requestApproval = context.approvals?.requestApproval ?? promptApprover;
        if (!requestApproval) return "solved";
        const decision = await requestApproval({
          id: `captcha:${info.url}`.slice(0, 200),
          kind: "human-check",
          domain: "browser",
          irreversibility: "reversible",
          reason: challengePrompt(info),
        });
        return decision.verb === "deny" ? "skip" : "solved";
      };
      browser = await createBrowser({
        headless: headless ?? true,
        attachOnly,
        cdpUrl,
        onChallenge,
        onFrame: (jpeg) => frameSink?.(jpeg),
        paceMs: Number(process.env.ARES_BROWSER_PACE_MS) || 480,
      });
    }
    return browser;
  };

  const ensureFilmstrip = (): Filmstrip => {
    if (!filmstrip) {
      const dir = path.join(context.browserFilmstripRoot, `${new Date().toISOString().slice(0, 10)}-${process.pid}`);
      filmstrip = new Filmstrip(dir);
    }
    return filmstrip;
  };

  return buildTool({
    name: "Browser",
    description:
      "Ares's DOM-first eyes and hands for the web — the ONLY tool for anything inside a web page. It drives CDP/Playwright input without touching the owner's OS mouse. Before opening a duplicate page it reuses a matching attached tab; use tabs/attach when the owner names an already-open tab. For multi-field or multi-click work use one act call with ordered steps, then inspect its final screenshot; do not spend one model call per click. Use APIs/MCP/CLI first when better. ComputerUse is forbidden for browser content. Run headless by default, visible only when the owner asks to watch or an authenticated Ares browser is needed. For visual verification use real screenshots; accessibility text alone cannot verify canvas/WebGL. Self-contained HTML must inline JS/CSS because offline webviews block CDN scripts.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: browserInput,
    activityDescription: (i) => {
      // Label honestly: opening a local file or driving the in-app page is NOT
      // "Browsing the web" — that wording made users think Ares went to the
      // internet instead of opening their file (bug report 4c5f1efc).
      const embedded = i.engine === "embedded" || (!i.url && !!i.html);
      const target = (u?: string) => {
        if (!u) return embedded ? "your page in the Ares window" : "a page";
        try {
          const parsed = new URL(u.includes("://") ? u : `https://${u}`);
          if (parsed.protocol === "file:")
            return `local file ${decodeURIComponent(parsed.pathname.split("/").pop() ?? "")}`.trim();
          if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return `local app ${parsed.host}`;
          return parsed.host.replace(/^www\./, "") || u;
        } catch {
          return u;
        }
      };
      if (i.action === "open") return `Opening ${target(i.url)}`;
      if (i.action === "act") return `Completing ${i.steps?.length ?? 0} browser actions`;
      if (i.action === "handshake") return "Attaching to an already-open browser";
      if (i.action === "tabs") return "Listing controllable browser tabs";
      if (i.action === "attach") return `Attaching to ${i.query ?? i.url ?? "an open tab"}`;
      if (i.action === "preview") return `Previewing ${target(i.url)}`;
      if (i.action === "tree") return "Reading the page";
      if (i.action === "screenshot" || i.action === "filmstrip") return embedded ? "Reading the in-app page" : "Capturing the screen";
      if (i.action === "fill") return i.label ? `Filling “${i.label}”` : "Filling a field";
      if (i.action === "fill_selector") return i.selector ? `Typing into ${i.selector}` : "Filling a field";
      if (i.action === "click") return i.name ? `Clicking “${i.name}”` : "Clicking a control";
      if (i.action === "click_text") return i.query ? `Clicking “${i.query}”` : "Clicking a control";
      if (i.action === "console") return "Reading the console";
      if (i.action === "eval") return "Testing in the page";
      if (i.action === "state") return "Checking the page state";
      if (i.action === "close") return "Closing the browser";
      return embedded ? "Using the in-app browser" : "Browsing the web";
    },

    async call(i, ctx): Promise<{ output: BrowserToolOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
      const strip = ensureFilmstrip();
      const emitTarget = (state: { url?: string; title?: string }) => {
        if (state.url) ctx?.emitProgress?.({ kind: "browser_target", url: state.url, title: state.title ?? "" });
      };
      // Route the browser's live frames into THIS turn's UI panel (the embedded
      // browser the owner watches). Cleared when the call ends.
      frameSink = ctx?.emitProgress
        ? (jpeg) => ctx.emitProgress?.({ kind: "browser_frame", image: jpeg } as Record<string, unknown>)
        : null;
      // This turn's approval surface for staged effects and challenge handoffs —
      // the engine permission card, same transport as every gated tool.
      const requestPermission = ctx?.requestPermission;
      promptApprover = requestPermission
        ? async (staged): Promise<ApprovalDecision> => {
            const verb = await requestPermission({
              toolName: "Browser",
              input: { kind: staged.kind, domain: staged.domain, irreversibility: staged.irreversibility },
              reason: `${staged.kind} — ${staged.reason}`,
            });
            return { id: staged.id, verb, at: new Date().toISOString(), approver: "owner" };
          }
        : null;

      // ── EMBEDDED ENGINE — drive Ares's own in-app browser (same-origin HTML) ──
      if (i.engine === "embedded") {
        const done = (status: string, result: unknown, display: string) =>
          ({ output: { action: i.action, status, result, filmstripDir: filmstripDir(strip) } as BrowserToolOutput, display });
        const snap = async () => (await embeddedBridge.exec("snapshot")).result;
        if (i.action === "preview" || i.action === "open") {
          if (!i.html) throw new Error("embedded preview requires `html` (the self-contained page to render)");
          const r = await embeddedBridge.exec("load", { html: i.html });
          if (!r.ok) throw new Error(r.error ?? "embedded load failed");
          return done("ok", await snap(), "rendered in the embedded browser");
        }
        if (i.action === "click" || i.action === "click_text") {
          const r = await embeddedBridge.exec("click", { query: i.query ?? i.name ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "click failed");
          return done("ok", { click: r.result, page: await snap() }, `clicked "${i.query ?? i.name}"`);
        }
        if (i.action === "fill" || i.action === "fill_selector") {
          const r = await embeddedBridge.exec("type", { selector: i.selector ?? i.label ?? "", value: i.value ?? "" });
          if (!r.ok) throw new Error((r.result as { error?: string })?.error ?? r.error ?? "fill failed");
          return done("ok", r.result, `typed into ${i.selector ?? i.label}`);
        }
        if (i.action === "eval") {
          if (!i.js) throw new Error("eval requires js");
          const r = await embeddedBridge.exec("eval", { js: i.js });
          return done(r.ok ? "ok" : "error", r.result, "eval");
        }
        if (i.action === "console") {
          const r = await embeddedBridge.exec("console", { onlyErrors: i.onlyErrors });
          if (!r.ok) throw new Error(r.error ?? "embedded console failed");
          const logs = (r.result as unknown[]) ?? [];
          return done("ok", logs, `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}`);
        }
        // tree / screenshot / state / snapshot → the page's DOM-text snapshot.
        const r = await embeddedBridge.exec("snapshot");
        // A dead bridge used to fall through as status:"ok" with an undefined
        // result in ~1ms — the model then "verified" pages it never saw.
        if (!r.ok) throw new Error(r.error ?? "embedded snapshot failed");
        if (i.action === "screenshot") {
          // The embedded engine has NO pixel capture. Never dress a DOM-text
          // dump up as a screenshot: canvas/WebGL/chart content is invisible in
          // text, so "status ok" here let models claim charts rendered when all
          // four canvases were blank (bug f0bbee26). Degrade loudly instead.
          return done(
            "degraded",
            {
              warning:
                "TEXT SNAPSHOT ONLY — the embedded engine cannot capture pixels. Canvas/WebGL/chart content is INVISIBLE here; do NOT claim anything rendered correctly based on this. To actually see the page, use action:'preview' with the playwright engine (pass the html or a file url) — that returns a real screenshot.",
              snapshot: r.result,
            },
            "text snapshot only — no pixels (use playwright preview to SEE the page)",
          );
        }
        return done("ok", r.result, "snapshot");
      }

      if (i.action === "filmstrip") {
        const result = (await strip.load()).slice(-(i.limit ?? 20));
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `filmstrip ${result.length} frame(s)`,
        };
      }

      if (i.action === "close") {
        if (browser) await browser.close();
        browser = null;
        return {
          output: { action: i.action, status: "closed", filmstripDir: filmstripDir(strip) },
          display: "browser closed",
        };
      }

      // Handshake is attach-only: it must never pretend success by quietly
      // launching a different, unauthenticated browser profile.
      // tabs/attach/handshake prefer the paired extension so Ares can take over
      // a real logged-in tab without launching another profile. Once attached,
      // the connector remains selected for subsequent act/click/fill calls.
      const extensionAttach = extensionBridge?.connected() && ["handshake", "tabs", "attach"].includes(i.action);
      const br = await ensureBrowser(i.action === "preview" ? false : i.headless, i.action === "handshake" || !!extensionAttach, i.url);

      if (i.action === "handshake") {
        if (!br.strategy?.startsWith("cdp:") && br.strategy !== "extension:native-messaging") {
          throw new Error("browser handshake did not attach to an owner-visible browser");
        }
        const tabs = br.tabs ? await br.tabs() : [];
        if (br.strategy === "extension:native-messaging") {
          if (!tabs.length || !br.attachToExisting || !(await br.attachToExisting(""))) {
            throw new Error("the extension is paired but no controllable web tab is open");
          }
        }
        const state = await br.state();
        emitTarget(state);
        return {
          output: {
            action: i.action,
            status: "attached",
            browserStrategy: br.strategy,
            result: { state, tabs, handshake: "owner-visible browser bridge accepted" },
            filmstripDir: filmstripDir(strip),
          },
          display: `attached to the open browser via ${br.strategy} (${tabs.length} tab${tabs.length === 1 ? "" : "s"})`,
        };
      }

      if (i.action === "tabs") {
        if (!br.tabs) throw new Error("tab discovery is not supported by this browser connector");
        const result = await br.tabs();
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `${result.length} controllable tab(s) via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "attach") {
        const query = i.query ?? i.url;
        if (!query) throw new Error("Browser attach requires query or url");
        if (!br.attachToExisting || !(await br.attachToExisting(query))) throw new Error(`no controllable open tab matched "${query}"`);
        const result = await br.state();
        emitTarget(result);
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `attached to ${result.title ?? result.url} via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "act") {
        if (!i.steps?.length) throw new Error("Browser act requires steps");
        const initial = await br.state();
        const hasClick = i.steps.some((step) => step.action === "click" || step.action === "click_text");
        const intendedUrl = i.steps.find((step) => step.action === "open" && step.url)?.url ?? initial.url;
        const journalKey = `act:${intendedUrl}:${JSON.stringify(i.steps)}`;
        const recent = recentOutwardActions.get(journalKey);
        if (hasClick && !i.allowRepeat && recent && Date.now() - recent < 15_000) {
          return {
            output: {
              action: i.action,
              status: "duplicate_suppressed",
              note: "ACTION NOT PERFORMED â€” this identical outward browser sequence committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true if repetition is intentional.",
              filmstripDir: filmstripDir(strip),
            },
            display: "duplicate browser sequence suppressed",
          };
        }
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect(
          "browser.act",
          hasClick ? "recoverable" : "reversible",
          `act:${sequence++}`,
          async () => {
            const completed: Array<{ step: number; action: string; state?: unknown; result?: unknown }> = [];
            for (let index = 0; index < i.steps!.length; index += 1) {
              const step = i.steps![index];
              try {
                if (step.action === "open") {
                  if (!step.url) throw new Error("open needs url");
                  await br.attachToExisting?.(step.url).catch(() => false);
                  await br.navigate(step.url);
                } else if (step.action === "click") {
                  if (!step.role || !step.name) throw new Error("click needs role and name");
                  await br.clickByRole(step.role, step.name);
                } else if (step.action === "click_text") {
                  if (!step.query || !br.clickByText) throw new Error("click_text needs query and connector support");
                  await br.clickByText(step.query);
                } else if (step.action === "fill") {
                  if (!step.label || step.value === undefined) throw new Error("fill needs label and value");
                  await br.fillByLabel(step.label, step.value);
                } else if (step.action === "fill_selector") {
                  if (!step.selector || step.value === undefined || !br.fillBySelector) throw new Error("fill_selector needs selector, value, and connector support");
                  await br.fillBySelector(step.selector, step.value);
                } else {
                  if (!step.js || !br.evaluate) throw new Error("eval needs js and connector support");
                  completed.push({ step: index + 1, action: step.action, result: await br.evaluate(step.js) });
                  continue;
                }
                completed.push({ step: index + 1, action: step.action, state: await br.state() });
              } catch (error) {
                throw new Error(`browser act stopped at step ${index + 1}/${i.steps!.length} (${step.action}): ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            const [shot, state, observed] = await Promise.all([
              br.screenshot(),
              br.state(),
              br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40)),
            ]);
            const frame = await strip.record({ action: `act ${i.steps!.length} steps`, url: state.url, screenshot: shot, note: i.note });
            return { completed, state, observed, shot, frame: frame.frame };
          },
          { idemPrefix: `browser:${process.pid}:${Date.now()}` },
        );
        const outcome = await runEffect(effect, rails);
        if (outcome.status !== "committed" || !outcome.result) {
          return {
            output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) },
            display: `browser sequence: ${outcome.status}`,
          };
        }
        if (hasClick) recentOutwardActions.set(journalKey, Date.now());
        const { shot, ...verified } = outcome.result;
        emitTarget(verified.state);
        return {
          output: { action: i.action, status: "committed", result: verified, filmstripDir: filmstripDir(strip) },
          display: `completed ${i.steps.length} browser actions · verified ${verified.state.title ?? verified.state.url}`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "tree") {
        const result = (await br.accessibilityTree()).slice(0, i.limit ?? 80);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `accessibility tree: ${result.length} node(s)`,
        };
      }

      if (i.action === "state") {
        const result = await br.state();
        emitTarget(result);
        return {
          output: { action: i.action, status: "ok", result, browserStrategy: br.strategy, filmstripDir: filmstripDir(strip) },
          display: `${result.title ?? "(untitled)"} ${result.url} via ${br.strategy ?? br.name}`,
        };
      }

      if (i.action === "screenshot") {
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        const frame = await strip.record({ action: "manual screenshot", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: frame, filmstripDir: filmstripDir(strip) },
          display: `screenshot frame ${frame.frame}`,
          // Hand the actual pixels to the model — without this it browses blind
          // off the accessibility tree alone and can't verify a click or read a
          // layout-dependent page. The viewport is 1280×800, under the vision limit.
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      // ── PREVIEW / VERIFY loop — visible cursor, click by text, console, eval ──
      if (i.action === "preview") {
        let url = i.url;
        if (!url && i.html) {
          // Inline HTML → write to a temp .html and open it. The reliable way to
          // preview a self-contained page (the embedded engine's inline render is
          // flaky — agents waste turns on its blank result; a real file always works).
          const tmp = path.join(os.tmpdir(), `ares-preview-${Date.now()}.html`);
          await writeFile(tmp, i.html, "utf8");
          url = pathToFileURL(tmp).href;
        }
        if (!url) throw new Error("Browser preview requires `url` (or `html` to render inline)");
        await br.navigate(url);
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        emitTarget(state);
        const frame = await strip.record({ action: "preview", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: { ...state, frame: frame.frame }, filmstripDir: filmstripDir(strip) },
          display: `preview ${state.url}`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "click_text") {
        if (!i.query) throw new Error("Browser click_text requires query (visible text or CSS selector)");
        if (!br.clickByText) throw new Error("click_text not supported by this browser");
        const before = await br.state();
        const journalKey = `click_text:${before.url}:${i.query}`;
        const recent = recentOutwardActions.get(journalKey);
        if (!i.allowRepeat && recent && Date.now() - recent < 15_000) {
          return {
            output: { action: i.action, status: "duplicate_suppressed", note: "ACTION NOT PERFORMED â€” this identical click committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true.", filmstripDir: filmstripDir(strip) },
            display: "duplicate click suppressed",
          };
        }
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect(
          "browser.click_text",
          "recoverable",
          `click-text:${i.query}`,
          async () => {
            await br.clickByText!(i.query!);
            const [shot, state, observed] = await Promise.all([br.screenshot(), br.state(), br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40))]);
            await strip.record({ action: `click ${i.query}`, url: state.url, screenshot: shot });
            return { shot, state, observed };
          },
          { idemPrefix: `browser:${process.pid}:${Date.now()}:${sequence++}` },
        );
        const outcome = await runEffect(effect, rails);
        if (outcome.status !== "committed" || !outcome.result) {
          return { output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) }, display: `click "${i.query}": ${outcome.status}` };
        }
        recentOutwardActions.set(journalKey, Date.now());
        const { shot, ...verified } = outcome.result;
        emitTarget(verified.state);
        return {
          output: { action: i.action, status: "committed", result: verified, filmstripDir: filmstripDir(strip) },
          display: `clicked "${i.query}"`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }

      if (i.action === "fill_selector") {
        if (!i.selector || i.value === undefined) throw new Error("Browser fill_selector requires selector and value");
        if (!br.fillBySelector) throw new Error("fill_selector not supported by this browser");
        const rails = await browserRailsContext(context, promptApprover);
        const effect = browserActionEffect("browser.fill_selector", "reversible", `fill-selector:${i.selector}`, () => br.fillBySelector!(i.selector!, i.value!), { idemPrefix: `browser:${process.pid}:${Date.now()}:${sequence++}` });
        const outcome = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: outcome.status, result: outcome, note: railsOutcomeNote(outcome), filmstripDir: filmstripDir(strip) },
          display: `fill ${i.selector}: ${outcome.status}`,
        };
      }

      if (i.action === "console") {
        if (!br.consoleLogs) throw new Error("console not supported by this browser");
        const logs = await br.consoleLogs({ onlyErrors: i.onlyErrors, limit: i.limit ?? 40 });
        return {
          output: { action: i.action, status: "ok", result: logs, filmstripDir: filmstripDir(strip) },
          display: `${logs.length} console entr${logs.length === 1 ? "y" : "ies"}${i.onlyErrors ? " (errors)" : ""}`,
        };
      }

      if (i.action === "eval") {
        if (!i.js) throw new Error("Browser eval requires js");
        if (!br.evaluate) throw new Error("eval not supported by this browser");
        const result = await br.evaluate(i.js);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: "eval ok",
        };
      }

      const rails = await browserRailsContext(context, promptApprover);
      const idemPrefix = `browser:${process.pid}:${Date.now()}:${sequence++}`;
      // A non-committed rails outcome must be UNMISSABLE: "staged" means the
      // action did NOT run (held for an approval surface that may not exist),
      // "denied" means it was refused. A bare status string let models read
      // either as success and "verify" clicks that never happened.
      const railsNote = (result: { status: string; reason?: string }): string | undefined =>
        result.status === "staged"
          ? `ACTION NOT PERFORMED — held for owner approval and never committed (${result.reason ?? "no approver available"}). Do not claim it happened; tell the owner it needs their approval.`
          : result.status === "denied"
            ? `ACTION NOT PERFORMED — refused (${result.reason ?? "approval denied"}). Do not retry the same call; tell the owner.`
            : undefined;

      if (i.action === "open") {
        if (!i.url) throw new Error("Browser open requires url");
        // If CDP can see a matching user/Ares tab, bind to it before navigating.
        // This preserves that tab's authenticated context and avoids duplicates.
        await br.attachToExisting?.(i.url).catch(() => false);
        const effect = navigateEffect(br, i.url, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        emitTarget(await br.state());
        return {
          output: { action: i.action, status: result.status, result, note: railsNote(result), filmstripDir: filmstripDir(strip) },
          display: `open ${i.url}: ${result.status}`,
        };
      }

      if (i.action === "fill") {
        if (!i.label) throw new Error("Browser fill requires label");
        if (i.value === undefined) throw new Error("Browser fill requires value");
        const effect = fillEffect(br, i.label, i.value, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: result.status, result, note: railsNote(result), filmstripDir: filmstripDir(strip) },
          display: `fill ${i.label}: ${result.status}`,
        };
      }

      if (!i.role || !i.name) throw new Error("Browser click requires role and name");
      const before = await br.state();
      const journalKey = `click:${before.url}:${i.role}:${i.name}`;
      const recent = recentOutwardActions.get(journalKey);
      if (!i.allowRepeat && recent && Date.now() - recent < 15_000) {
        return {
          output: { action: i.action, status: "duplicate_suppressed", note: "ACTION NOT PERFORMED â€” this identical click committed less than 15 seconds ago. Verify the existing outcome or pass allowRepeat:true.", filmstripDir: filmstripDir(strip) },
          display: "duplicate click suppressed",
        };
      }
      const effect = clickEffect(br, i.role, i.name, { filmstrip: strip, idemPrefix });
      const result = await runEffect(effect, rails);
      if (result.status === "committed") {
        recentOutwardActions.set(journalKey, Date.now());
        const [shot, state, observed] = await Promise.all([br.screenshot(), br.state(), br.accessibilityTree().then((nodes) => nodes.slice(0, i.limit ?? 40))]);
        emitTarget(state);
        return {
          output: { action: i.action, status: result.status, result: { effect: result, state, observed }, filmstripDir: filmstripDir(strip) },
          display: `click ${i.role}:${i.name}: committed · verified`,
          images: [{ mediaType: `image/${shot.format ?? "png"}`, data: shot.bytes }],
        };
      }
      return {
        output: { action: i.action, status: result.status, result, note: railsNote(result), filmstripDir: filmstripDir(strip) },
        display: `click ${i.role}:${i.name}: ${result.status}`,
      };
    },
  });
}

function isClosedBrowserError(error: unknown): boolean {
  return /target (?:page|context|browser) has been closed|browser has been closed|page has been closed/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function railsOutcomeNote(result: { status: string; reason?: string }): string | undefined {
  if (result.status === "staged") {
    return `ACTION NOT PERFORMED — held for owner approval and never committed (${result.reason ?? "no approver available"}). Do not claim it happened; tell the owner it needs their approval.`;
  }
  if (result.status === "denied") {
    return `ACTION NOT PERFORMED — refused (${result.reason ?? "approval denied"}). Do not retry the same call; tell the owner.`;
  }
  return undefined;
}

/**
 * V8 — which leash governs outward effects:
 *   guarded (default): autonomy is earned through the TrustGovernor.
 *   unleashed (dangerousBypass: true): the owner's dial, wide open.
 *   derives each domain's leash from the Crucible (confirmed procedures with
 *   net-positive records), and every level change lands in leash.jsonl next to
 *   the effects ledger with the evidence that justified it.
 */
async function resolveLeash(context: CliRuntimeContext): Promise<(domain: string) => number> {
  const settings = await loadUiSettings();
  if (settings.dangerousBypass === true) return ownerLeash();
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const leashLog = path.join(context.effects.effectsDir, "leash.jsonl");
    const governor = new TrustGovernor({
      nodes: () => store.all(),
      append: (change) =>
        mkdir(path.dirname(leashLog), { recursive: true })
          .then(() => appendFile(leashLog, JSON.stringify(change) + "\n"))
          .catch(() => undefined),
    });
    return (domain) => governor.leashOf(domain);
  } catch {
    // No readable memory: guarded mode falls back to the shortest leash.
    return ownerLeash({ trust: 1 });
  }
}

/** Budget ceilings from env — ARES_BUDGET_DAILY (dollars) and ARES_BUDGET_PER_DOMAIN
 *  ("domain=amount,domain2=amount2"). Mirrors the ARES_OPERATOR_* env-config
 *  convention used elsewhere in this file rather than a UiSettings field, since
 *  the budget ceiling is an operator-wide guardrail, not a per-session UI knob. */
function budgetLimitsFromEnv(): BudgetLimits {
  const limits: BudgetLimits = {};
  const daily = Number(process.env.ARES_BUDGET_DAILY);
  if (Number.isFinite(daily) && daily > 0) limits.daily = daily;
  const perDomainRaw = process.env.ARES_BUDGET_PER_DOMAIN;
  if (perDomainRaw) {
    const perDomain: Record<string, number> = {};
    for (const pair of perDomainRaw.split(",")) {
      const [domain, amountRaw] = pair.split("=").map((v) => v.trim());
      const amount = Number(amountRaw);
      if (domain && Number.isFinite(amount) && amount > 0) perDomain[domain] = amount;
    }
    if (Object.keys(perDomain).length) limits.perDomain = perDomain;
  }
  return limits;
}

async function browserRailsContext(
  context: CliRuntimeContext,
  promptApprover?: RailsContext["requestApproval"] | null,
): Promise<RailsContext> {
  const paths = context.effects;
  // Approver precedence: the garrison gateway when it's up, else THIS turn's
  // engine permission prompt (the same card/transport every gated tool uses).
  // Before the fallback existed, a desktop session had NO approver at all, so a
  // staged click (guarded mode, browser leash 1 < recoverable's required 2) was
  // held forever and the tool reported "staged" — a click that silently never
  // happened. Now it pauses on a real approval card and commits or refuses.
  const requestApproval: RailsContext["requestApproval"] =
    context.approvals?.requestApproval ?? promptApprover ?? undefined;
  return {
    ledger: await Ledger.open(paths.ledgerFile),
    // The ceiling only bites once some effect actually carries a nonzero
    // EffectCost.dollars — none do today (see EffectCost in @ares/effects).
    // This wiring makes the ceiling REAL and configurable for when that
    // changes; it is not an active spend guard yet.
    budget: new Budget(budgetLimitsFromEnv()),
    killSwitch: new KillSwitch(paths.killSwitchFile),
    leashOf: await resolveLeash(context),
    requestApproval,
  };
}

function filmstripDir(strip: Filmstrip): string {
  return (strip as unknown as { dir?: string }).dir ?? "filmstrip";
}
