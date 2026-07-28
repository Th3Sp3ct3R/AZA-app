// ComputerUse — drive the REAL desktop: screenshot, move, click, type, key,
// scroll. The capability that turns "an agent that types" into "an agent that
// operates your machine" — delete a Chrome extension, click through a native
// dialog, drive an app that has no API.
//
// Windows-first and ZERO new dependencies: it shells out to the built-in
// PowerShell + .NET (System.Windows.Forms / System.Drawing + a tiny user32
// P/Invoke). No nut.js, no robotjs, no native module to install — so it can
// never hit the "install loop" the headless browser used to. On non-Windows
// hosts it returns a terminal, non-retriable error telling the model to stop.
//
// Screenshots come back as IMAGE tool-results (EngineToolResult.images), so a
// vision-capable model literally sees the pixels and can act on what's on screen.

import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    action: z
      .enum([
        "screenshot",
        "zoom",
        "window",
        "windows",
        "move",
        "click",
        "double_click",
        "right_click",
        "type",
        "key",
        "scroll",
        "cursor",
        "launch",
        "activate",
        "uia_tree",
        "uia_click",
        "uia_fill",
        "act",
      ])
      .describe(
        "Observe with screenshot/window/windows/zoom. Prefer uia_tree then uia_click/uia_fill by accessible name. Use act for ordered desktop/UIA steps with one final capture; target pins and re-verifies the foreground window before state changes. Pixel, keyboard, launch, and activate actions remain fallbacks.",
      ),
    x: z.number().int().optional().describe("Target X for move/click/zoom — in the pixel coordinates of the LAST image you were shown (top-left origin)."),
    y: z.number().int().optional().describe("Target Y for move/click/zoom — in the pixel coordinates of the LAST image you were shown (top-left origin)."),
    w: z.number().int().positive().optional().describe("Zoom region width, in the LAST image's pixel space (default covers ~800 screen px)."),
    h: z.number().int().positive().optional().describe("Zoom region height, in the LAST image's pixel space (default covers ~600 screen px)."),
    text: z.string().optional().describe("Literal text for type; program/URI for launch; window-title substring for activate."),
    target: z.string().optional().describe("Required foreground window title/process substring. The tool re-activates and verifies it immediately before acting."),
    name: z.string().optional().describe("Accessible name for uia_click/uia_fill."),
    role: z.string().optional().describe("Optional UI Automation control type, such as Button, Edit, or MenuItem."),
    value: z.string().optional().describe("Value for uia_fill."),
    key: z.string().optional().describe("Key combo for the key action, or launch arguments."),
    amount: z.number().int().optional().describe("Wheel notches for scroll (negative scrolls down). Default 3."),
    steps: z.array(z.object({
      action: z.enum(["move", "click", "double_click", "right_click", "type", "key", "scroll", "activate", "uia_click", "uia_fill"]),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      amount: z.number().int().optional(),
      name: z.string().optional(),
      role: z.string().optional(),
      value: z.string().optional(),
    }).strict()).min(1).max(32).optional().describe("act: execute up to 32 desktop/UIA steps in one tool call, with one final verification capture."),
  })
  .strict();

export interface WindowInfo {
  title: string;
  process?: string;
  /** Top-left + size in absolute virtual-desktop pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  visible: boolean;
}

export interface ComputerUseOutput {
  ok: boolean;
  action: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Downscale factor of the last shown image (physical px per image px). */
  scale?: number;
  /** Open top-level windows (for the `windows` action). */
  windows?: WindowInfo[];
  error?: string;
  /** Where the screenshot PNG was also saved on disk (for desktop preview). */
  screenshotPath?: string;
  note?: string;
  /** True when a post-action verification capture was taken and attached. */
  verified?: boolean;
  /** Whether the screen changed vs. the pre-action capture (undefined = no baseline). */
  changed?: boolean;
  /** Audit line for keyboard-tier actions: what was injected, and into which window. */
  audit?: string;
  /** Title of the top-level window under the cursor when a click landed. */
  window?: string;
  /** Title of the window actually activated (for the `activate` action). */
  title?: string;
  /** UI Automation elements or post-action accessible observation. */
  elements?: Array<{ name: string; role: string; automationId?: string; enabled?: boolean }>;
  observed?: string;
  completed?: Array<{ step: number; action: string; outcome: string }>;
}

const MOUSE_ACTIONS = new Set(["move", "click", "double_click", "right_click"]);

/**
 * Per-action permission tiers. The static schema safety stays "external-state"
 * (conservative for the watchdog class + conductor filtering); the PERMISSION
 * decision uses the per-input tier via dynamicSafety:
 *   - read-only (no confirmation cost): screenshot / zoom / window / windows /
 *     cursor — they only observe the screen.
 *   - standard (external-state ask): move / click / scroll / launch / activate.
 *   - risky (external-state ask + audit line + env gate): type / key — they
 *     inject keystrokes into whatever holds focus. ARES_COMPUTERUSE_ALLOW_TYPING=0
 *     blocks them outright (default: allowed).
 */
const READ_ONLY_ACTIONS = new Set(["screenshot", "zoom", "window", "windows", "cursor", "uia_tree"]);
const TYPING_ACTIONS = new Set(["type", "key"]);

/**
 * Everything needed to map a click from the IMAGE the model saw back to an
 * absolute point on the real (possibly multi-monitor) desktop:
 *   - origin{X,Y}: the virtual-desktop top-left (vs.X/vs.Y), which on multi-monitor
 *     rigs is NOT (0,0) and can be NEGATIVE (a monitor left/above the primary).
 *   - capture{W,H}: the physical pixels captured (the full virtual desktop, or a
 *     zoom region).
 *   - image{W,H}: the dimensions of the image actually shown to the model after
 *     downscaling (the long edge is capped to the vision limit).
 */
export interface ShotMeta {
  originX: number;
  originY: number;
  captureW: number;
  captureH: number;
  imageW: number;
  imageH: number;
}

const IDENTITY_SHOT: ShotMeta = { originX: 0, originY: 0, captureW: 1, captureH: 1, imageW: 1, imageH: 1 };

/** State-changing actions that get a post-action verification capture. */
const VERIFY_ACTIONS = new Set(["click", "double_click", "right_click", "type", "key", "scroll", "uia_click", "uia_fill"]);

function captureHash(imageBase64: string): string {
  return createHash("sha1").update(imageBase64).digest("hex");
}

function shotMetaFrom(result: PsResult): ShotMeta {
  return {
    originX: result.originX ?? 0,
    originY: result.originY ?? 0,
    captureW: result.captureW && result.captureW > 0 ? result.captureW : (result.width ?? 1),
    captureH: result.captureH && result.captureH > 0 ? result.captureH : (result.height ?? 1),
    imageW: result.width && result.width > 0 ? result.width : 1,
    imageH: result.height && result.height > 0 ? result.height : 1,
  };
}

function unchangedNote(action: string): string {
  return MOUSE_ACTIONS.has(action)
    ? `screen unchanged after ${action} — the click may have missed`
    : `screen unchanged after ${action} — the input may not have registered`;
}

/**
 * Map an image-space coordinate (what the model returns) to an absolute
 * virtual-desktop coordinate (what the OS click API needs). Two steps, PURE:
 *   1. image → physical capture: multiply by a PER-AXIS scale derived from the
 *      real captured/image dimensions (not an assumed single factor, so rounding
 *      and any aspect divergence can't skew it).
 *   2. physical capture → absolute virtual desktop: add the capture origin, so a
 *      negative / non-(0,0) virtual origin is handled and there's no monitor-width
 *      skew.
 */
export function mapImageToVirtual(ix: number, iy: number, shot: ShotMeta): { x: number; y: number } {
  const scaleX = shot.imageW > 0 ? shot.captureW / shot.imageW : 1;
  const scaleY = shot.imageH > 0 ? shot.captureH / shot.imageH : 1;
  return {
    x: Math.round(shot.originX + ix * scaleX),
    y: Math.round(shot.originY + iy * scaleY),
  };
}

/** Per-axis scale factors for the last capture (physical px per image px). */
export function shotScale(shot: ShotMeta): { scaleX: number; scaleY: number } {
  return {
    scaleX: shot.imageW > 0 ? shot.captureW / shot.imageW : 1,
    scaleY: shot.imageH > 0 ? shot.captureH / shot.imageH : 1,
  };
}

/** Debug-only trace of a coordinate mapping — stderr, gated, never in normal logs. */
function traceMapping(action: string, ix: number, iy: number, shot: ShotMeta, mapped: { x: number; y: number }): void {
  if (process.env.ARES_COMPUTER_DEBUG !== "1") return;
  const { scaleX, scaleY } = shotScale(shot);
  process.stderr.write(
    `[ComputerUse] ${action} model=(${ix},${iy}) image=${shot.imageW}x${shot.imageH} ` +
      `capture=${shot.captureW}x${shot.captureH} origin=(${shot.originX},${shot.originY}) ` +
      `scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)}) -> virtual=(${mapped.x},${mapped.y})\n`,
  );
}

/**
 * Internal (non-model-facing) extensions the tool itself attaches when calling
 * the runner: `_phys` marks zoom coordinates as ALREADY physical (verification
 * and activate captures), and markX/markY ask the driver to draw a click marker
 * at that physical point on the capture so the model SEES where it clicked.
 */
export type RunnerInput = z.infer<typeof inputSchema> & { _phys?: boolean; markX?: number; markY?: number };

export type ComputerActionRunner = (input: RunnerInput, shot: ShotMeta) => Promise<PsResult>;

export function makeComputerUseTool(runner: ComputerActionRunner = runComputerAction) {
  // Per-tool capture state: the mapping metadata of the last image the model
  // saw, plus its content hash for post-action change detection.
  let lastShot: ShotMeta = { ...IDENTITY_SHOT };
  let lastShotHash: string | null = null;
  // Rolling record of recent clicks (physical coords + whether the screen
  // changed) — powers the in-tool loop guard that catches "clicking the same
  // spot over and over" long before the engine's generic breakers can.
  let recentClicks: Array<{ x: number; y: number; changed: boolean | undefined }> = [];
  const realDesktop = runner === runComputerAction;

  return buildTool({
    name: "ComputerUse",
    description:
      "Control the REAL Windows desktop for native apps. Prefer UI Automation: uia_tree then uia_click/uia_fill by accessible name. For multi-step work use act with target=<window title>; focus is re-verified before every state change and one final capture proves the outcome. Use pixels only when no accessible control exists: windows, activate/window/zoom, then click and inspect the marked verification capture. NEVER use this for web content; Browser handshake/tabs/attach/act is faster and does not steal the owner's mouse. Do not repeat an unchanged click blindly.",
    safety: "external-state",
    concurrency: "exclusive",
    inputZod: inputSchema,
    dynamicSafety: (i) => (READ_ONLY_ACTIONS.has(i.action) ? "read-only" : "external-state"),

    // Per-action semantic checks: catch the calls that fail (or silently no-op)
    // deep in the PowerShell driver, with a one-sentence fix.
    async validateInput(i) {
      if (TYPING_ACTIONS.has(i.action) && process.env.ARES_COMPUTERUSE_ALLOW_TYPING === "0") {
        return {
          ok: false,
          message: `${i.action} is blocked: keyboard input is disabled (ARES_COMPUTERUSE_ALLOW_TYPING=0). Use click-based UI interaction, or ask the owner to re-enable typing.`,
        };
      }
      if (i.action === "type" && !i.text) {
        return { ok: false, message: "type needs `text` — the literal characters to type into the focused window." };
      }
      if (i.action === "key" && !i.key) {
        return { ok: false, message: "key needs `key` — a SendKeys combo like ^c, %{F4}, {ENTER}, or a WIN chord like WIN+R." };
      }
      if (i.action === "launch" && !i.text?.trim()) {
        return { ok: false, message: "launch needs `text` — a program name (notepad), full path, or URI (ms-settings:)." };
      }
      if (i.action === "activate" && !i.text?.trim()) {
        return { ok: false, message: "activate needs `text` — a substring of the target window's title (use `windows` to list them)." };
      }
      if (i.action === "act" && !i.steps?.length) {
        return { ok: false, message: "act needs `steps` â€” ordered desktop/UIA actions to run in one focused transaction." };
      }
      if ((i.action === "uia_click" || i.action === "uia_fill") && !i.name?.trim()) {
        return { ok: false, message: `${i.action} needs an accessible control \`name\` (use uia_tree first).` };
      }
      if (i.action === "uia_fill" && i.value === undefined) {
        return { ok: false, message: "uia_fill needs `value`." };
      }
      if (
        i.action === "activate" &&
        process.env.ARES_COMPUTERUSE_ALLOW_BROWSER !== "1" &&
        /\b(chrome|edge|firefox|brave|opera|vivaldi|browser|x —|youtube|twitter)\b/i.test(i.text ?? "")
      ) {
        // Default-closed: a web page steering the model must never reach the
        // physical mouse. The OWNER can lift it (their machine, their call).
        return {
          ok: false,
          message: "ComputerUse cannot activate browser windows. Use Browser tabs/attach/open: it controls the page without stealing the owner's mouse and renders the Ares cursor in-page. If the owner explicitly wants Ares driving their real browser with the mouse, they can flip Settings → Advanced → 'Desktop control of browser windows' — tell them that, don't work around it.",
        };
      }
      if ((i.action === "move" || i.action === "zoom") && (i.x === undefined || i.y === undefined)) {
        return { ok: false, message: `${i.action} needs both x and y — pixel coordinates from the LAST image you were shown.` };
      }
      if (MOUSE_ACTIONS.has(i.action) && (i.x === undefined) !== (i.y === undefined)) {
        return { ok: false, message: `${i.action} got only one of x/y — pass BOTH coordinates, or neither to act at the current cursor position.` };
      }
      return { ok: true };
    },

    activityDescription: (i) => {
      if (i.action === "screenshot") return "Capturing the screen";
      if (i.action === "window") return "Capturing the active window";
      if (i.action === "windows") return "Listing open windows";
      if (i.action === "uia_tree") return "Reading accessible desktop controls";
      if (i.action === "uia_click") return `Clicking accessible control ${i.name ?? ""}`;
      if (i.action === "uia_fill") return `Filling accessible control ${i.name ?? ""}`;
      if (i.action === "act") return `Completing ${i.steps?.length ?? 0} desktop actions`;
      if (i.action === "launch") return `Launching ${i.text ?? "an app"}`;
      if (i.action === "type") return "Typing on the desktop";
      if (i.action === "key") return `Pressing ${i.key ?? "a key"}`;
      if (MOUSE_ACTIONS.has(i.action) && i.x !== undefined) return `${i.action} at ${i.x},${i.y}`;
      return `Computer: ${i.action}`;
    },

    async call(i, _ctx): Promise<{ output: ComputerUseOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
      if (process.env.ARES_COMPUTER_USE === "0") {
        throw new Error("COMPUTER_USE_DISABLED: ComputerUse is turned off (ARES_COMPUTER_USE=0).");
      }
      if (realDesktop && process.platform !== "win32") {
        // Terminal, non-retriable — do NOT try to install anything, switch tools.
        throw new Error(
          "COMPUTER_USE_UNAVAILABLE: desktop control is Windows-only in this build. Use the Browser tool for web tasks, or do the work through files/CLI instead.",
        );
      }

      const ensureTargetFocused = async (target: string | undefined): Promise<void> => {
        if (!target?.trim()) return;
        const focused = await runner({ action: "activate", text: target.trim() } as RunnerInput, lastShot);
        if (!focused.ok) throw new Error(`ComputerUse focus handshake failed: ${focused.error ?? `could not activate ${target}`}`);
        if (focused.foreground === false) throw new Error(`ComputerUse focus handshake failed: Windows did not grant foreground focus to "${focused.title ?? target}"`);
      };

      if (i.action === "act") {
        const completed: Array<{ step: number; action: string; outcome: string }> = [];
        for (let index = 0; index < i.steps!.length; index += 1) {
          const step = i.steps![index];
          if (step.action !== "activate") await ensureTargetFocused(i.target);
          const result = await runner(step as RunnerInput, lastShot);
          if (!result.ok) throw new Error(`ComputerUse act stopped at step ${index + 1}/${i.steps!.length} (${step.action}): ${result.error ?? "unknown error"}`);
          if (result.image) {
            lastShot = shotMetaFrom(result);
            lastShotHash = result.rawHash ?? captureHash(result.image);
          }
          completed.push({
            step: index + 1,
            action: step.action,
            outcome: result.observed ?? result.title ?? result.focus ?? "ok",
          });
        }
        const capture = await runner({ action: "window" } as RunnerInput, lastShot).catch(() => runner({ action: "screenshot" } as RunnerInput, lastShot));
        const output: ComputerUseOutput = {
          ok: true,
          action: "act",
          completed,
          verified: capture.ok && !!capture.image,
          observed: completed.at(-1)?.outcome,
          note: capture.ok && capture.image
            ? "batched desktop transaction completed; final focused-window capture attached"
            : "batched desktop transaction completed, but final verification capture failed",
        };
        if (capture.ok && capture.image) {
          lastShot = shotMetaFrom(capture);
          lastShotHash = capture.rawHash ?? captureHash(capture.image);
          return { output, display: `Completed ${completed.length} desktop actions · verified`, images: [{ mediaType: "image/png", data: capture.image }] };
        }
        return { output, display: `Completed ${completed.length} desktop actions · verification unavailable` };
      }

      if (!READ_ONLY_ACTIONS.has(i.action) && i.action !== "activate") await ensureTargetFocused(i.target);

      const result = await runner(i, lastShot);
      if (!result.ok) {
        throw new Error(`ComputerUse ${i.action} failed: ${result.error ?? "unknown error"}`);
      }

      if (i.action === "windows") {
        const windows = result.windows ?? [];
        return {
          output: { ok: true, action: "windows", windows, note: `${windows.length} open window(s). 'activate' the one you want by title — it focuses the window and attaches a fresh capture of it.` },
          display: `Listed ${windows.length} window(s)`,
        };
      }

      if (i.action === "uia_tree") {
        const elements = result.elements ?? [];
        return {
          output: { ok: true, action: i.action, elements, note: `${elements.length} accessible control(s); prefer uia_click/uia_fill by name over pixel coordinates.` },
          display: `Read ${elements.length} accessible control(s)`,
        };
      }

      if (i.action === "activate") {
        // Focus succeeded — now SHOW the model what it focused. An immediate
        // window capture makes the very next click land in the right coordinate
        // space instead of a stale multi-monitor screenshot.
        recentClicks = [];
        const title = result.title ?? i.text ?? "";
        const output: ComputerUseOutput = { ok: true, action: "activate", title };
        let images: Array<{ mediaType: string; data: string }> | undefined;
        let note = `activated "${title}"`;
        if (result.foreground === false) {
          note += " — Windows did NOT grant it foreground focus; check the attached capture before typing";
        }
        if (typeof result.x === "number" && (result.width ?? 0) > 0 && (result.height ?? 0) > 0) {
          const settleMs = Number(process.env.ARES_COMPUTERUSE_SETTLE_MS ?? 120);
          if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
          const cap = await runner(
            { action: "zoom", x: result.x, y: result.y, w: result.width, h: result.height, _phys: true } as RunnerInput,
            lastShot,
          ).catch((err): PsResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          if (cap.ok && cap.image) {
            lastShot = shotMetaFrom(cap);
            lastShotHash = cap.rawHash ?? captureHash(cap.image);
            images = [{ mediaType: "image/png", data: cap.image }];
            note += " — window capture attached; give coordinates in THIS image's pixel space";
          }
        }
        output.note = note;
        return { output, display: `Activated "${title}"`, images };
      }

      if ((i.action === "screenshot" || i.action === "zoom" || i.action === "window") && result.image) {
        // Remember the full mapping metadata so the NEXT click/move converts the
        // model's image-space coordinate back to the right spot on the real desktop.
        lastShot = shotMetaFrom(result);
        lastShotHash = result.rawHash ?? captureHash(result.image);
        // Persist a copy under ARES_HOME (asset-protocol scope) so the desktop can
        // preview it; fall back to tmp if home isn't set.
        let screenshotPath: string | undefined;
        try {
          const base = process.env.ARES_HOME
            ? path.join(process.env.ARES_HOME, "screenshots")
            : path.join(os.tmpdir(), "ares-screenshots");
          await fs.mkdir(base, { recursive: true });
          screenshotPath = path.join(base, `shot-${Date.now()}.png`);
          await fs.writeFile(screenshotPath, Buffer.from(result.image, "base64"));
        } catch {
          screenshotPath = undefined;
        }
        const { scaleX } = shotScale(lastShot);
        const native = scaleX <= 1.001 ? "(native resolution)" : `(downscaled ${scaleX.toFixed(2)}×)`;
        let note = `Captured ${native}. Give click/move coordinates in THIS image's pixel space (top-left origin); they're mapped to the real screen automatically. If a target is small or text is hard to read, 'zoom' into its region for a native-resolution view.`;
        if (i.action === "screenshot" && scaleX > 2.2) {
          note += ` WARNING: this full-desktop capture is downscaled ${scaleX.toFixed(1)}× — each image pixel is ~${Math.round(scaleX)} real pixels, so small targets are NOT reliably clickable from it. 'activate' the target window (attaches a window-only capture) or 'zoom' before clicking.`;
        }
        const output: ComputerUseOutput = {
          ok: true,
          action: i.action,
          width: result.width,
          height: result.height,
          scale: scaleX,
          screenshotPath,
          note,
        };
        return {
          output,
          display: `Captured ${i.action} ${result.width}×${result.height}`,
          images: [{ mediaType: "image/png", data: result.image }],
        };
      }

      const output: ComputerUseOutput = {
        ok: true,
        action: i.action,
        x: result.x,
        y: result.y,
        observed: result.observed,
      };
      let display = describeDone(i, result);
      // Keyboard tier: an explicit audit line — what was injected, into which
      // window — so a transcript reviewer (and the model) can see exactly where
      // the keystrokes went. Survives the verification note below.
      if (TYPING_ACTIONS.has(i.action)) {
        const focus = result.focus?.trim() ? `"${result.focus.trim()}"` : "the focused window";
        output.audit =
          i.action === "type"
            ? `typed ${(i.text ?? "").length} chars into ${focus}`
            : `pressed ${i.key ?? ""} in ${focus}`;
        display = output.audit.charAt(0).toUpperCase() + output.audit.slice(1);
      }
      // Click accountability: the driver reports which top-level window was
      // under the cursor when the click fired. The #1 silent failure in the
      // wild was clicks landing on the WRONG window (often Ares itself, after
      // it stole focus back) with the model none the wiser.
      const clickedWindow = MOUSE_ACTIONS.has(i.action) && i.action !== "move" ? result.focus?.trim() : undefined;
      let selfClick = false;
      if (clickedWindow) {
        output.window = clickedWindow;
        display = `${display} on "${clickedWindow}"`;
        selfClick = /^ares(\s|$)/i.test(clickedWindow);
      }
      let images: Array<{ mediaType: string; data: string }> | undefined;

      // Vision verification: after a state-changing action, take ONE post-action
      // capture (same region the model last saw), attach it so the model SEES the
      // effect, and hash-compare against the pre-action capture — "clicked blind"
      // becomes "clicked, looked, and knows whether anything happened". For mouse
      // actions the capture carries a red marker at the exact click point, so the
      // model can SEE where its click actually landed. No retry loops here;
      // self-correction is the model's job. ARES_COMPUTERUSE_VERIFY=0 disables.
      if (VERIFY_ACTIONS.has(i.action) && process.env.ARES_COMPUTERUSE_VERIFY !== "0") {
        // 120ms settles a click's visual effect on modern UIs; the old 350ms
        // was a large slice of the per-action wall clock users complained about.
        const settleMs = Number(process.env.ARES_COMPUTERUSE_SETTLE_MS ?? 120);
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
        const hadBaseline = lastShotHash !== null && lastShot.captureW > 1;
        const mark =
          MOUSE_ACTIONS.has(i.action) && i.action !== "move" && typeof result.x === "number" && typeof result.y === "number"
            ? { markX: result.x, markY: result.y }
            : {};
        const captureInput = (hadBaseline
          ? { action: "zoom", x: lastShot.originX, y: lastShot.originY, w: lastShot.captureW, h: lastShot.captureH, _phys: true, ...mark }
          : { action: "screenshot", ...mark }) as RunnerInput;
        const capture = await runner(captureInput, lastShot).catch(
          (err): PsResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
        if (capture.ok && capture.image) {
          // Change detection compares UNMARKED content hashes (the driver hashes
          // before drawing the click marker) — otherwise the marker itself would
          // make every capture look "changed".
          const postHash = capture.rawHash ?? captureHash(capture.image);
          const changed = hadBaseline ? postHash !== lastShotHash : undefined;
          lastShot = shotMetaFrom(capture);
          lastShotHash = postHash;
          output.verified = true;
          output.changed = changed;
          const markNote = "markX" in mark ? " The red circle marks where your click landed." : "";
          output.note =
            changed === false
              ? `${unchangedNote(i.action)}.${markNote}`
              : changed
                ? `screen changed after the action — post-action screenshot attached; coordinates now refer to THIS image.${markNote}`
                : `post-action screenshot attached (no prior capture to compare against); coordinates now refer to THIS image.${markNote}`;
          display = changed === false
            ? `${display} — ${unchangedNote(i.action)}`
            : `${display} — verified (screen ${changed ? "changed" : "captured"})`;
          images = [{ mediaType: "image/png", data: capture.image }];
        } else {
          output.note = `post-action verification capture failed (${capture.error ?? "unknown error"}) — take a screenshot to confirm the effect`;
        }
      }

      // In-tool loop guard: catch same-spot click flailing NOW, inside the tool
      // result the model reads next, instead of after the engine burns 80
      // iterations. Two triggers: (a) 3 clicks in the same ~40px spot none of
      // which changed the screen — the click point is dead; (b) 4 clicks in the
      // same spot even WITH screen changes — a toggle loop (open → close → open).
      if (MOUSE_ACTIONS.has(i.action) && i.action !== "move" && typeof result.x === "number" && typeof result.y === "number") {
        recentClicks.push({ x: result.x, y: result.y, changed: output.changed });
        if (recentClicks.length > 6) recentClicks.shift();
        const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
          Math.abs(a.x - b.x) <= 40 && Math.abs(a.y - b.y) <= 40;
        const lastN = (n: number) => recentClicks.slice(-n);
        const clustered = (n: number) => {
          const c = lastN(n);
          return c.length === n && c.every((p) => near(p, c[0]));
        };
        let loopNote: string | undefined;
        if (clustered(3) && lastN(3).every((p) => p.changed === false)) {
          loopNote =
            "LOOP GUARD: you've clicked this same spot 3 times and the screen never changed — this click point is DEAD. Stop clicking it. Re-establish state: 'windows' → 'activate' the target (fresh capture attached) → re-aim from THAT image, or use keyboard navigation instead.";
        } else if (clustered(4)) {
          loopNote =
            "LOOP GUARD: 4 clicks on the same spot — you are toggling something open and closed, or the click isn't producing the outcome you want. STOP and change approach: re-activate the target window, zoom to confirm what the element actually is, or drive it with the keyboard ({TAB}, {ENTER}, arrow keys).";
        }
        if (loopNote) {
          recentClicks = [];
          output.note = output.note ? `${output.note}\n${loopNote}` : loopNote;
          display = `${display} — LOOP GUARD tripped`;
        }
      } else if (i.action === "launch") {
        recentClicks = [];
      }

      // Self-click alarm: the model clicked the Ares app itself — the target
      // window was never foreground. Make that unmissable.
      if (selfClick) {
        const warn =
          "WARNING: this click landed on the ARES window itself — your target app is NOT in the foreground. 'activate' the target window by title before clicking again.";
        output.note = output.note ? `${output.note}\n${warn}` : warn;
      }

      return { output, display, images };
    },
  });
}

export const ComputerUseTool = makeComputerUseTool();

function describeDone(i: z.infer<typeof inputSchema>, r: PsResult): string {
  switch (i.action) {
    case "cursor":
      return `Cursor at ${r.x},${r.y}`;
    case "move":
      return `Moved to ${r.x},${r.y}`;
    case "type":
      return `Typed ${(i.text ?? "").length} chars`;
    case "key":
      return `Pressed ${i.key ?? ""}`;
    case "scroll":
      return `Scrolled ${i.amount ?? 3}`;
    default:
      return `${i.action} done`;
  }
}

interface PsResult {
  ok: boolean;
  action?: string;
  image?: string;
  /** Image dimensions shown to the model (after downscaling). */
  width?: number;
  height?: number;
  /** Physical pixels captured (full virtual desktop, or the zoom region). */
  captureW?: number;
  captureH?: number;
  scale?: number;
  /** Virtual-desktop origin of the capture (vs.X/vs.Y, or the captured window/region top-left). */
  originX?: number;
  originY?: number;
  x?: number;
  y?: number;
  windows?: WindowInfo[];
  elements?: Array<{ name: string; role: string; automationId?: string; enabled?: boolean }>;
  observed?: string;
  /** Foreground-window title at type/key time; window under the cursor for clicks. */
  focus?: string;
  /** Matched window title (activate). */
  title?: string;
  /** Whether the activated window actually became foreground (activate). */
  foreground?: boolean;
  /** SHA1 of the capture BEFORE the click marker was drawn (change detection). */
  rawHash?: string;
  error?: string;
}

/**
 * The wire to the PowerShell host must be pure ASCII: Node writes UTF-8, but a
 * Windows PowerShell console reads stdin in the OEM codepage (cp437/cp850), so
 * an em-dash or emoji arrives as mojibake ("ΓÇô") and gets TYPED into the
 * target app. JSON \uXXXX escapes survive any codepage and ConvertFrom-Json
 * decodes them back to the exact characters.
 */
function asciiSafeJson(json: string): string {
  return json.replace(new RegExp("[\\u007f-\\uffff]", "g"), (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}

let scriptPathPromise: Promise<string> | null = null;

async function ensureScript(): Promise<string> {
  scriptPathPromise ??= (async () => {
    const file = path.join(os.tmpdir(), "ares-computeruse.ps1");
    await fs.writeFile(file, POWERSHELL_DRIVER, "utf8");
    return file;
  })();
  return scriptPathPromise;
}

// ── Persistent PowerShell host ──────────────────────────────────────────────
// The old design spawned a FRESH powershell.exe per action, paying the
// Add-Type C# JIT (~1-3s) every single click — the dominant share of the
// 5-15s/action users saw. The host compiles once, then executes actions from
// a stdin JSON-line loop for the life of the process.

interface PsHost {
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  pending: Array<{ resolve: (r: PsResult) => void; timer: NodeJS.Timeout }>;
  buffer: string;
}

let psHost: PsHost | null = null;
let actionChain: Promise<unknown> = Promise.resolve();

async function ensureHost(): Promise<PsHost> {
  if (psHost && psHost.child.exitCode === null && !psHost.child.killed) return psHost;
  const script = await ensureScript();
  const ps = process.env.ARES_POWERSHELL || "powershell";
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
  });
  const host: PsHost = { child, pending: [], buffer: "" };
  const marker = "ARES_RESULT:";
  child.stdout.on("data", (b: Buffer) => {
    host.buffer += b.toString("utf8");
    let idx = host.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = host.buffer.slice(0, idx).trim();
      host.buffer = host.buffer.slice(idx + 1);
      if (line.includes(marker)) {
        const waiter = host.pending.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as PsResult);
          } catch {
            waiter.resolve({ ok: false, error: "unparseable driver result" });
          }
        }
      }
      idx = host.buffer.indexOf("\n");
    }
  });
  const failAll = (why: string) => {
    if (psHost === host) psHost = null;
    for (const waiter of host.pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: why });
    }
  };
  child.on("error", (err) => failAll(`PowerShell host failed: ${err.message}`));
  child.on("close", (code) => failAll(`PowerShell host exited (${code ?? "killed"})`));
  psHost = host;
  return host;
}

/**
 * Convert a runner input's model-facing coordinates (image space of the LAST
 * capture) to physical virtual-desktop pixels. Pure — exported for tests.
 * Mouse actions map x/y; model-issued zooms map x/y AND scale w/h; internal
 * captures (`_phys: true`) pass through untouched.
 */
export function normalizeActionCoords(
  input: RunnerInput,
  shot: ShotMeta,
): { physX: number | null; physY: number | null; physW: number | null; physH: number | null } {
  let physX: number | null = input.x ?? null;
  let physY: number | null = input.y ?? null;
  let physW: number | null = input.w ?? null;
  let physH: number | null = input.h ?? null;
  if (MOUSE_ACTIONS.has(input.action) && input.x !== undefined && input.y !== undefined) {
    const p = mapImageToVirtual(input.x, input.y, shot);
    physX = p.x;
    physY = p.y;
    traceMapping(input.action, input.x, input.y, shot, p);
  } else if (input.action === "zoom" && !input._phys && input.x !== undefined && input.y !== undefined) {
    // The schema tells the model x/y/w/h are in the LAST image's pixel space —
    // honor that. (Historically zoom read them as physical pixels, so on a
    // downscaled multi-monitor screenshot every model zoom landed up-left of
    // the intended region and the model flailed with repeated zooms.)
    const p = mapImageToVirtual(input.x, input.y, shot);
    const { scaleX, scaleY } = shotScale(shot);
    physX = p.x;
    physY = p.y;
    if (input.w !== undefined) physW = Math.max(1, Math.round(input.w * scaleX));
    if (input.h !== undefined) physH = Math.max(1, Math.round(input.h * scaleY));
    traceMapping("zoom", input.x, input.y, shot, p);
  }
  return { physX, physY, physW, physH };
}

async function runComputerAction(input: RunnerInput, shot: ShotMeta): Promise<PsResult> {
  // Mouse actions AND model-issued zooms: convert the model's image-space
  // coordinates to physical screen pixels. Internal captures (verification,
  // post-activate) pass `_phys: true` because their coords are already physical.
  const { physX, physY, physW, physH } = normalizeActionCoords(input, shot);
  const payload = asciiSafeJson(JSON.stringify({
    action: input.action,
    x: physX,
    y: physY,
    w: physW,
    h: physH,
    // `type` text goes through SendInput KEYEVENTF_UNICODE in the driver, so it
    // is passed RAW — any character (em-dash, emoji, CJK) lands exactly as-is.
    // `key` keeps SendKeys notation for combos. launch/activate use raw text.
    text: input.text ?? "",
    key: input.key ?? "",
    amount: input.amount ?? 3,
    name: input.name ?? "",
    role: input.role ?? "",
    value: input.value ?? "",
    markX: input.markX ?? null,
    markY: input.markY ?? null,
  }));
  // Serialize actions: the host answers strictly in order, so pending waiters
  // are matched FIFO — never interleave two writes.
  const run = actionChain.then(async (): Promise<PsResult> => {
    const attempt = (): Promise<PsResult> =>
      new Promise<PsResult>((resolve) => {
        void ensureHost().then((host) => {
          const timer = setTimeout(() => {
            // Wedged action: kill the host (next call respawns it) and report.
            try { host.child.kill(); } catch { /* already dead */ }
            resolve({ ok: false, error: "computer action timed out after 20s" });
          }, 20_000);
          host.pending.push({ resolve, timer });
          host.child.stdin.write(payload + "\n", (err) => {
            if (err) {
              clearTimeout(timer);
              const i = host.pending.findIndex((w) => w.timer === timer);
              if (i >= 0) host.pending.splice(i, 1);
              resolve({ ok: false, error: `PowerShell host write failed: ${err.message}` });
            }
          });
        }).catch((err: unknown) => resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
    let result = await attempt();
    // One transparent retry on host death (stale host from a previous timeout).
    if (!result.ok && /host (failed|exited)|write failed/i.test(result.error ?? "")) {
      result = await attempt();
    }
    return result;
  });
  actionChain = run.catch(() => undefined);
  return run;
}

// The driver: a PERSISTENT host. Setup (Add-Type JIT) runs once, then actions
// arrive as JSON lines on stdin; each prints exactly one `ARES_RESULT:{json}`
// line. Passing an action-file path still works (legacy one-shot mode).
const POWERSHELL_DRIVER = String.raw`param([string]$ActionFile)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Out-Result($obj) { [Console]::Out.WriteLine("ARES_RESULT:" + ($obj | ConvertTo-Json -Compress -Depth 6)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct AresRect { public int Left; public int Top; public int Right; public int Bottom; }
public struct AresPoint { public int X; public int Y; }
public class AresWinInfo { public long H; public string Title; public uint Pid; public bool Iconic; public int L; public int T; public int R; public int B; }
public static class AresIn {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out AresRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
public static class AresWin {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out AresRect r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, IntPtr ex);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(AresPoint p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

  public static List<AresWinInfo> List() {
    var list = new List<AresWinInfo>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new System.Text.StringBuilder(len + 2);
      GetWindowText(h, sb, len + 2);
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
      if (cloaked != 0) return true;
      AresRect r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new AresWinInfo { H = h.ToInt64(), Title = sb.ToString(), Pid = pid, Iconic = IsIconic(h), L = r.Left, T = r.Top, R = r.Right, B = r.Bottom });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  // Robust foreground: restore if minimized, Alt-tap to satisfy the OS
  // foreground-lock heuristic, then AttachThreadInput as the heavy fallback.
  public static bool Activate(long hRaw) {
    var h = new IntPtr(hRaw);
    if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(120); }
    keybd_event(0x12, 0, 0, IntPtr.Zero); keybd_event(0x12, 0, 2, IntPtr.Zero);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(80);
    if (GetForegroundWindow() == h) return true;
    uint fgPid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fgThread, true);
    try { BringWindowToTop(h); SetForegroundWindow(h); } finally { AttachThreadInput(me, fgThread, false); }
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == h;
  }
  public static string TitleAt(int x, int y) {
    var p = new AresPoint(); p.X = x; p.Y = y;
    var h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return "";
    var root = GetAncestor(h, 2);
    if (root == IntPtr.Zero) root = h;
    int len = GetWindowTextLength(root);
    var sb = new System.Text.StringBuilder(len + 2);
    GetWindowText(root, sb, len + 2);
    return sb.ToString();
  }
}
public static class AresType {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static INPUT Ki(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1;
    i.U.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  // Types literal text via KEYEVENTF_UNICODE — every character (em-dash, emoji,
  // CJK) lands exactly, unlike SendKeys which mangles anything non-ASCII that
  // survived the console codepage. Newlines/tabs become real Enter/Tab presses.
  // Chunked with small sleeps so web editors (Discord, X) don't drop bursts.
  public static int Type(string s) {
    var batch = new List<INPUT>();
    int sent = 0;
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { batch.Add(Ki(0x0D, 0, 0)); batch.Add(Ki(0x0D, 0, 2)); }
      else if (c == '\t') { batch.Add(Ki(0x09, 0, 0)); batch.Add(Ki(0x09, 0, 2)); }
      else { batch.Add(Ki(0, c, 4)); batch.Add(Ki(0, c, 4 | 2)); }
      if (batch.Count >= 64) {
        sent += (int)SendInput((uint)batch.Count, batch.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        batch.Clear();
        System.Threading.Thread.Sleep(12);
      }
    }
    if (batch.Count > 0) sent += (int)SendInput((uint)batch.Count, batch.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    return sent;
  }
}
"@
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  function Set-Pos($x, $y) { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$x, [int]$y) }
  function Get-FocusTitle {
    try {
      $h = [AresIn]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { return '' }
      $sb = New-Object System.Text.StringBuilder 512
      [void][AresIn]::GetWindowText($h, $sb, 512)
      return $sb.ToString()
    } catch { return '' }
  }
  function Get-UiaRoot {
    $h = [AresIn]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { return $null }
    try { return [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { return $null }
  }
  function Find-Uia([string]$name, [string]$role) {
    $root = Get-UiaRoot
    if ($null -eq $root) { return $null }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
    $first = $walker.GetFirstChild($root)
    while ($null -ne $first) { $stack.Push($first); $first = $walker.GetNextSibling($first) }
    $needle = $name.Trim().ToLower()
    $roleNeedle = $role.Trim().ToLower()
    $visited = 0
    while ($stack.Count -gt 0 -and $visited -lt 3000) {
      $el = $stack.Pop(); $visited++
      try {
        $n = [string]$el.Current.Name
        $ct = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')
        $nameMatch = ($n.ToLower() -eq $needle) -or ($n.ToLower().Contains($needle))
        $roleMatch = ($roleNeedle -eq '') -or ($ct.ToLower() -eq $roleNeedle)
        if ($nameMatch -and $roleMatch -and -not $el.Current.IsOffscreen) { return $el }
      } catch { }
      try {
        $child = $walker.GetFirstChild($el)
        while ($null -ne $child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
      } catch { }
    }
    return $null
  }
  function Uia-Snapshot {
    $root = Get-UiaRoot
    $out = @()
    if ($null -eq $root) { return $out }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object 'System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]'
    $first = $walker.GetFirstChild($root)
    while ($null -ne $first) { $stack.Push($first); $first = $walker.GetNextSibling($first) }
    $visited = 0
    while ($stack.Count -gt 0 -and $visited -lt 3000 -and $out.Count -lt 120) {
      $el = $stack.Pop(); $visited++
      try {
        $n = [string]$el.Current.Name
        $id = [string]$el.Current.AutomationId
        $ct = ([string]$el.Current.ControlType.ProgrammaticName).Replace('ControlType.','')
        if (($n -ne '' -or $id -ne '') -and -not $el.Current.IsOffscreen) {
          $out += @{ name = $n; role = $ct; automationId = $id; enabled = [bool]$el.Current.IsEnabled }
        }
      } catch { }
      try {
        $child = $walker.GetFirstChild($el)
        while ($null -ne $child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
      } catch { }
    }
    return $out
  }
  function Mouse($down, $up) {
    [AresIn]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [AresIn]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
  }
  function HashB64([string]$s) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try { return (($sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
  }
  # Capture an arbitrary screen rectangle, downscaling so the long edge is <=
  # 1568px (the model's vision limit; above it the API silently shrinks the image
  # and small UI text becomes unaimable). Reports captured size, image size,
  # scale, and origin so a click in the image maps back to the exact screen pixel.
  # Optional markX/markY (physical px): draws a red click marker AFTER hashing the
  # unmarked frame, so change-detection compares real screen content, while the
  # model still SEES exactly where its click landed.
  function Capture-Region($rx, $ry, $rw, $rh, $markX, $markY) {
    # Clamp to the virtual desktop so an off-by-a-monitor region can't throw.
    $rx = [Math]::Max($vs.X, [Math]::Min([int]$rx, $vs.X + $vs.Width - 1))
    $ry = [Math]::Max($vs.Y, [Math]::Min([int]$ry, $vs.Y + $vs.Height - 1))
    $rw = [Math]::Max(1, [Math]::Min([int]$rw, $vs.X + $vs.Width - $rx))
    $rh = [Math]::Max(1, [Math]::Min([int]$rh, $vs.Y + $vs.Height - $ry))
    $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen([int]$rx, [int]$ry, 0, 0, (New-Object System.Drawing.Size([int]$rw, [int]$rh)))
    $g.Dispose()
    $maxEdge = [Math]::Max($rw, $rh)
    $scale = 1.0
    if ($maxEdge -gt 1568) { $scale = $maxEdge / 1568.0 }
    $outW = [int][Math]::Round($rw / $scale)
    $outH = [int][Math]::Round($rh / $scale)
    $img = $bmp
    if ($scale -gt 1.0) {
      $img = New-Object System.Drawing.Bitmap($outW, $outH)
      $sg = [System.Drawing.Graphics]::FromImage($img)
      $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $sg.DrawImage($bmp, 0, 0, $outW, $outH)
      $sg.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $rawB64 = [Convert]::ToBase64String($ms.ToArray())
    $rawHash = HashB64 $rawB64
    $outB64 = $rawB64
    if ($markX -ne $null -and $markY -ne $null) {
      $mx = ([double]$markX - $rx) / $scale
      $my = ([double]$markY - $ry) / $scale
      if ($mx -ge 0 -and $my -ge 0 -and $mx -lt $outW -and $my -lt $outH) {
        $mg = [System.Drawing.Graphics]::FromImage($img)
        $mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
        $mg.DrawEllipse($pen, [single]($mx - 11), [single]($my - 11), 22, 22)
        $mg.DrawLine($pen, [single]($mx - 18), [single]$my, [single]($mx + 18), [single]$my)
        $mg.DrawLine($pen, [single]$mx, [single]($my - 18), [single]$mx, [single]($my + 18))
        $pen.Dispose(); $mg.Dispose()
        $ms2 = New-Object System.IO.MemoryStream
        $img.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
        $outB64 = [Convert]::ToBase64String($ms2.ToArray())
        $ms2.Dispose()
      }
    }
    if ($scale -gt 1.0) { $img.Dispose() }
    $bmp.Dispose()
    $ms.Dispose()
    return @{ image = $outB64; rawHash = $rawHash; width = $outW; height = $outH; captureW = [int]$rw; captureH = [int]$rh; scale = $scale; originX = [int]$rx; originY = [int]$ry }
  }
  function Invoke-AresAction($a) {
  try {
  switch ($a.action) {
    'screenshot' {
      $s = Capture-Region $vs.X $vs.Y $vs.Width $vs.Height $a.markX $a.markY
      Out-Result @{ ok = $true; action = 'screenshot'; image = $s.image; rawHash = $s.rawHash; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
    }
    'zoom' {
      $zx = [int]$a.x; $zy = [int]$a.y
      $zw = [int]$a.w; $zh = [int]$a.h
      if ($zw -le 0) { $zw = 800 }
      if ($zh -le 0) { $zh = 600 }
      $s = Capture-Region $zx $zy $zw $zh $a.markX $a.markY
      Out-Result @{ ok = $true; action = 'zoom'; image = $s.image; rawHash = $s.rawHash; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
    }
    'window' {
      $h = [AresIn]::GetForegroundWindow()
      if ($h -eq [IntPtr]::Zero) { Out-Result @{ ok = $false; error = 'no foreground window' } }
      else {
        $r = New-Object AresRect
        if (-not [AresIn]::GetWindowRect($h, [ref]$r)) { Out-Result @{ ok = $false; error = 'could not read the foreground window rect' } }
        else {
          $ww = $r.Right - $r.Left; $wh = $r.Bottom - $r.Top
          if ($ww -le 0 -or $wh -le 0) { Out-Result @{ ok = $false; error = 'foreground window has no visible area (minimized?)' } }
          else {
            $s = Capture-Region $r.Left $r.Top $ww $wh $a.markX $a.markY
            Out-Result @{ ok = $true; action = 'window'; image = $s.image; rawHash = $s.rawHash; width = $s.width; height = $s.height; captureW = $s.captureW; captureH = $s.captureH; scale = $s.scale; originX = $s.originX; originY = $s.originY }
          }
        }
      }
    }
    'windows' {
      # EnumWindows-based: sees EVERY top-level window (multiple per process),
      # skips cloaked/ghost UWP shells — unlike Get-Process MainWindowHandle
      # which shows at most one window per process and misses the rest.
      $list = @()
      $procNames = @{}
      foreach ($w in [AresWin]::List()) {
        $pn = ''
        if ($procNames.ContainsKey($w.Pid)) { $pn = $procNames[$w.Pid] }
        else {
          try { $pn = (Get-Process -Id $w.Pid -ErrorAction Stop).ProcessName } catch { $pn = '' }
          $procNames[$w.Pid] = $pn
        }
        $list += @{ title = $w.Title; process = $pn; x = $w.L; y = $w.T; width = ($w.R - $w.L); height = ($w.B - $w.T); minimized = [bool]$w.Iconic; visible = $true }
      }
      Out-Result @{ ok = $true; action = 'windows'; windows = @($list) }
    }
    'uia_tree' {
      $els = Uia-Snapshot
      Out-Result @{ ok = $true; action = 'uia_tree'; elements = @($els); observed = ((@($els | Select-Object -First 12 | ForEach-Object { $_.role + ':' + $_.name })) -join ' | ') }
    }
    'uia_click' {
      $el = Find-Uia ([string]$a.name) ([string]$a.role)
      if ($null -eq $el) { Out-Result @{ ok = $false; error = ("no visible UI Automation control matched '" + $a.name + "'" ) } }
      else {
        $done = $false; $pat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
          ([System.Windows.Automation.InvokePattern]$pat).Invoke(); $done = $true
        } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
          ([System.Windows.Automation.SelectionItemPattern]$pat).Select(); $done = $true
        }
        if (-not $done) {
          $r = $el.Current.BoundingRectangle
          if ($r.IsEmpty) { Out-Result @{ ok = $false; error = 'matched accessible control has no clickable rectangle' }; return }
          $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
          Set-Pos $cx $cy; Mouse 0x0002 0x0004
        }
        Start-Sleep -Milliseconds 80
        Out-Result @{ ok = $true; action = 'uia_click'; observed = ("invoked " + $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','') + " '" + $el.Current.Name + "'"); focus = (Get-FocusTitle) }
      }
    }
    'uia_fill' {
      $el = Find-Uia ([string]$a.name) ([string]$a.role)
      if ($null -eq $el) { Out-Result @{ ok = $false; error = ("no visible UI Automation control matched '" + $a.name + "'" ) } }
      else {
        $pat = $null; $set = $false
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pat)) {
          $vp = [System.Windows.Automation.ValuePattern]$pat
          if (-not $vp.Current.IsReadOnly) { $vp.SetValue([string]$a.value); $set = $true }
        }
        if (-not $set) {
          $el.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('^a'); [void][AresType]::Type([string]$a.value)
        }
        Start-Sleep -Milliseconds 60
        $observed = "filled " + $el.Current.ControlType.ProgrammaticName.Replace('ControlType.','') + " '" + $el.Current.Name + "'"
        Out-Result @{ ok = $true; action = 'uia_fill'; observed = $observed; focus = (Get-FocusTitle) }
      }
    }
    'launch' {
      $target = ([string]$a.text).Trim()
      $argline = [string]$a.key
      # Resolve a few common names so "open settings"/"launch notepad" just work.
      $aliases = @{ 'settings' = 'ms-settings:'; 'notepad' = 'notepad.exe'; 'calc' = 'calc.exe'; 'calculator' = 'calc.exe'; 'explorer' = 'explorer.exe'; 'files' = 'explorer.exe'; 'cmd' = 'cmd.exe'; 'terminal' = 'wt.exe'; 'task manager' = 'taskmgr.exe'; 'control panel' = 'control.exe'; 'paint' = 'mspaint.exe' }
      $key = $target.ToLower()
      if ($aliases.ContainsKey($key)) { $target = $aliases[$key] }
      try {
        if ($argline -ne '') { Start-Process -FilePath $target -ArgumentList $argline -ErrorAction Stop }
        else { Start-Process -FilePath $target -ErrorAction Stop }
        Out-Result @{ ok = $true; action = 'launch' }
      } catch {
        Out-Result @{ ok = $false; error = ("could not launch '" + $target + "': " + $_.Exception.Message + ". Try a full path, an executable name (notepad.exe), or a shell URI (ms-settings:).") }
      }
    }
    'activate' {
      # Substring window matching + robust foregrounding. The old AppActivate
      # needed an exact/prefix title and failed constantly ("Process '{0}' was
      # not found") — the #1 cause of clicks landing on the wrong window.
      $q = ([string]$a.text).Trim()
      $ql = $q.ToLower()
      $wins = [AresWin]::List()
      $procNames = @{}
      $best = $null
      $bestScore = -1
      foreach ($w in $wins) {
        $tl = $w.Title.ToLower()
        $pn = ''
        if ($procNames.ContainsKey($w.Pid)) { $pn = $procNames[$w.Pid] }
        else {
          try { $pn = (Get-Process -Id $w.Pid -ErrorAction Stop).ProcessName } catch { $pn = '' }
          $procNames[$w.Pid] = $pn
        }
        $score = -1
        if ($tl -eq $ql) { $score = 100 }
        elseif ($tl.StartsWith($ql)) { $score = 80 }
        elseif ($tl.Contains($ql)) { $score = 60 }
        elseif ($pn -and $pn.ToLower().Contains($ql)) { $score = 40 }
        if ($score -ge 0) {
          if (-not $w.Iconic) { $score += 5 }
          $area = [Math]::Max(0, $w.R - $w.L) * [Math]::Max(0, $w.B - $w.T)
          $score += [Math]::Min(4, [int]($area / 500000))
          if ($score -gt $bestScore) { $bestScore = $score; $best = $w }
        }
      }
      if ($null -eq $best) {
        $titles = @($wins | Sort-Object { -(($_.R - $_.L) * ($_.B - $_.T)) } | Select-Object -First 10 | ForEach-Object { $_.Title }) -join "' | '"
        Out-Result @{ ok = $false; error = ("no open window title or process matched '" + $q + "'. Open windows: '" + $titles + "'") }
      } else {
        $fg = [AresWin]::Activate($best.H)
        Start-Sleep -Milliseconds 100
        $r = New-Object AresRect
        [void][AresIn]::GetWindowRect((New-Object IntPtr($best.H)), [ref]$r)
        Out-Result @{ ok = $true; action = 'activate'; title = $best.Title; foreground = [bool]$fg; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
      }
    }
    'cursor' {
      $p = [System.Windows.Forms.Cursor]::Position
      Out-Result @{ ok = $true; action = 'cursor'; x = $p.X; y = $p.Y }
    }
    'move' {
      Set-Pos $a.x $a.y
      Out-Result @{ ok = $true; action = 'move'; x = [int]$a.x; y = [int]$a.y }
    }
    'click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      $p = [System.Windows.Forms.Cursor]::Position
      $t = [AresWin]::TitleAt($p.X, $p.Y)
      Mouse 0x0002 0x0004
      Out-Result @{ ok = $true; action = 'click'; x = $p.X; y = $p.Y; focus = $t }
    }
    'double_click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      $p = [System.Windows.Forms.Cursor]::Position
      $t = [AresWin]::TitleAt($p.X, $p.Y)
      Mouse 0x0002 0x0004; Start-Sleep -Milliseconds 60; Mouse 0x0002 0x0004
      Out-Result @{ ok = $true; action = 'double_click'; x = $p.X; y = $p.Y; focus = $t }
    }
    'right_click' {
      if ($a.x -ne $null) { Set-Pos $a.x $a.y; Start-Sleep -Milliseconds 20 }
      $p = [System.Windows.Forms.Cursor]::Position
      $t = [AresWin]::TitleAt($p.X, $p.Y)
      Mouse 0x0008 0x0010
      Out-Result @{ ok = $true; action = 'right_click'; x = $p.X; y = $p.Y; focus = $t }
    }
    'scroll' {
      $notches = [int]$a.amount
      if ($notches -eq 0) { $notches = 3 }
      $delta = $notches * 120
      if ($delta -lt 0) { $delta = $delta + 4294967296 }
      [AresIn]::mouse_event(0x0800, 0, 0, [uint32]$delta, [IntPtr]::Zero)
      Out-Result @{ ok = $true; action = 'scroll' }
    }
    'type' {
      $focus = Get-FocusTitle
      $txt = [string]$a.text
      $sent = [AresType]::Type($txt)
      if ($sent -le 0 -and $txt.Length -gt 0) {
        Out-Result @{ ok = $false; error = 'SendInput injected nothing — the desktop may be locked or a UAC prompt has input focus' }
      } else {
        Out-Result @{ ok = $true; action = 'type'; focus = $focus }
      }
    }
    'key' {
      $k = [string]$a.key
      $focus = Get-FocusTitle
      if ($k -match '^(?i:win)\b') {
        # SendKeys can't press the Windows key. Hold LWIN (0x5B) and tap the rest.
        $rest = ($k -replace '^(?i:win)\s*\+?\s*', '')
        [AresIn]::keybd_event(0x5B, 0, 0, [IntPtr]::Zero)
        if ($rest.Length -gt 0) { [System.Windows.Forms.SendKeys]::SendWait($rest) }
        Start-Sleep -Milliseconds 40
        [AresIn]::keybd_event(0x5B, 0, 2, [IntPtr]::Zero)
        Out-Result @{ ok = $true; action = 'key'; focus = $focus }
      } else {
        [System.Windows.Forms.SendKeys]::SendWait($k)
        Out-Result @{ ok = $true; action = 'key'; focus = $focus }
      }
    }
    default { Out-Result @{ ok = $false; error = ("unknown action: " + $a.action) } }
  }
  } catch {
    Out-Result @{ ok = $false; error = $_.Exception.Message }
  }
  }

  if ($ActionFile) {
    # Legacy one-shot mode: action JSON in a file, exit after.
    $a = Get-Content -Raw -LiteralPath $ActionFile | ConvertFrom-Json
    Invoke-AresAction $a
  } else {
    # Host mode: JSON action per stdin line, result per stdout line, forever.
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      $line = $line.Trim()
      if ($line -eq '') { continue }
      try { $a = $line | ConvertFrom-Json } catch { Out-Result @{ ok = $false; error = 'unparseable action json' }; continue }
      Invoke-AresAction $a
    }
  }
}
catch {
  Out-Result @{ ok = $false; error = $_.Exception.Message }
}
`;
