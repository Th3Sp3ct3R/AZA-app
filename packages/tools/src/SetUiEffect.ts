// SetUiEffect — Ares restyles its own working effect, on request.
//
// The desktop shows a small "working" indicator (a smoothly rotating ember
// ring beside the session title) plus, in "glow" effects mode, a static ember
// rim. When the owner asks for a different vibe ("make it blue", "calmer",
// "call it 'forging'"), the agent calls this tool and the DESKTOP applies the
// change: the UI watches the event stream for this tool call and persists the
// accent in its prefs. The daemon-side implementation is therefore just
// validation + echo — there is deliberately no file or process side effect.
//
// Photosensitive-safety is enforced by construction: the only tunables are a
// hue rotation of the existing ember palette, one of THREE fixed slow ring
// paces, and a short caption. Nothing here can make the UI flash.

import { z } from "zod";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    hue: z
      .number()
      .min(0)
      .max(360)
      .optional()
      .describe("Palette rotation in degrees around the color wheel. 0 = the default ember/copper. ~120 shifts green, ~200 shifts blue/cyan, ~280 violet."),
    speed: z
      .enum(["calm", "steady", "brisk"])
      .optional()
      .describe("Pace of the working ring's rotation. calm ≈ 4.6s/turn, steady ≈ 2.8s (default), brisk ≈ 1.6s. All are smooth rotation — nothing flashes."),
    label: z
      .string()
      .max(24)
      .optional()
      .describe("Short caption shown beside the ring while working (e.g. 'forging', 'hunting'). Omit to keep showing the live activity."),
  })
  .strict();

export interface SetUiEffectOutput {
  applied: { hue?: number; speed?: string; label?: string };
  note: string;
}

export const SetUiEffectTool = buildTool({
  name: "SetUiEffect",
  description:
    "Restyle the desktop's working-state effect — the small rotating ember ring and the glow accent shown while you work. Use when the owner asks to change the working animation's color, pace, or caption ('make the glow blue', 'calmer effect', 'call it forging'). hue rotates the ember palette (0-360), speed is calm/steady/brisk, label is a short caption. The change applies live and persists. This cannot flash or strobe — only recolor and re-pace a smooth rotation.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) =>
    `Restyling the working effect${typeof i.hue === "number" ? ` · hue ${Math.round(i.hue)}°` : ""}${i.speed ? ` · ${i.speed}` : ""}`,

  async call(i): Promise<{ output: SetUiEffectOutput; display: string }> {
    const applied = {
      hue: typeof i.hue === "number" ? Math.round(i.hue) % 360 : undefined,
      speed: i.speed,
      label: i.label?.trim() || undefined,
    };
    return {
      output: {
        applied,
        note: "The desktop applies this live from the event stream and persists it in its preferences. If the owner is on the TUI or Telegram, there is no visual effect to change — say so instead of pretending.",
      },
      display: `✨ Working effect restyled${applied.hue !== undefined ? ` · hue ${applied.hue}°` : ""}${applied.speed ? ` · ${applied.speed}` : ""}${applied.label ? ` · "${applied.label}"` : ""}`,
    };
  },
});
