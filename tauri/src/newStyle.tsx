// ─── New-Style desktop skin — "Forged" ──────────────────────────────────────
//
// The GPU/spring/agent-graph visual leap, all gated behind the persisted
// `uiStyle` preference. Legacy mode ("legacy") renders plain markup and is
// pixel-identical to the pre-skin app; everything here activates only when
// the root carries data-style="new" (see styles.css) or when a component
// reads StyleCtx === "new".
//
// Performance law: no per-frame React renders. Springed numbers write to the
// DOM through framer-motion motion values; the token-flow strip owns a single
// rAF loop that pauses when idle or when the document is hidden. All motion
// respects prefers-reduced-motion via framer's useReducedMotion (CSS motion is
// separately nuked by the global reduced-motion rule in styles.css).

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useSpring, useTransform } from "framer-motion";

export type UiStyle = "legacy" | "new" | "modern";

/** Provided at the app root from prefs.uiStyle. Defaults to legacy so any
 *  stray render outside the provider stays on the untouched path. */
export const StyleCtx = createContext<UiStyle>("legacy");

/** True for every non-legacy skin. "modern" (the glass-forge reskin) keeps all
 *  the Forged runtime behaviors — springs, gauges, token flow — and restyles
 *  the surfaces in CSS (modern.css, scoped under data-style="modern"). */
export function useNewStyle(): boolean {
  return useContext(StyleCtx) !== "legacy";
}

/** The raw skin, for the few places that must render different MARKUP (not just
 *  different CSS) — e.g. the composer swapping its glyphs for Ares sigils. */
export function useUiStyle(): UiStyle {
  return useContext(StyleCtx);
}

// ─── SpringNumber — a numeric readout that glides instead of jumping ────────
//
// In legacy mode (or under reduced motion) it renders the plain formatted
// value — same text, same inline layout. In new style the number is driven by
// a spring motion value written straight to the text node (no re-renders).

export function SpringNumber({
  value,
  format = (n: number) => String(n),
  className,
  title,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
  title?: string;
}) {
  const newStyle = useNewStyle();
  const reduced = useReducedMotion();
  const spring = useSpring(value, { stiffness: 110, damping: 24, mass: 0.9 });
  const text = useTransform(spring, (v) => format(Math.max(0, Math.round(v))));
  useEffect(() => {
    spring.set(value);
  }, [spring, value]);
  if (!newStyle || reduced) {
    return (
      <span className={className} title={title}>
        {format(Math.max(0, Math.round(value)))}
      </span>
    );
  }
  return (
    <motion.span className={className} title={title}>
      {text}
    </motion.span>
  );
}

// ─── SpringHeight — a container whose height springs to fit its content ─────
//
// Used by the tool cards: when a running card collapses to its compact ✓ line
// (or the user expands the breakdown) the outer box springs between heights
// instead of snapping. Content is measured with a ResizeObserver — state only
// updates when the content size actually changes, never per frame.

export function SpringHeight({
  children,
  className,
  attrs,
}: {
  children: React.ReactNode;
  className?: string;
  /** data-* attributes forwarded to the animated container. */
  attrs?: Record<string, string>;
}) {
  const inner = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState<number | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      {...(attrs as Record<string, string>)}
      className={className}
      initial={false}
      animate={h === null || reduced ? undefined : { height: h }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      style={{ overflow: "hidden", height: h === null || reduced ? "auto" : undefined }}
    >
      {/* The animated height is `inner.offsetHeight`, which does NOT include the
          OUTER element's padding — so any padding on the container makes its
          content overflow its own box and get clipped by overflow:hidden, worse
          the taller the content grows. Skins must therefore hang card padding on
          this inner wrapper (see .springInner in modern.css), never on the
          animated container. min-width:0 keeps a wide child (a long path, a code
          fragment) from forcing intrinsic width instead of wrapping. */}
      <div ref={inner} className="springInner" style={{ minWidth: 0 }}>
        {children}
      </div>
    </motion.div>
  );
}

// ─── Token flow — chars streamed per second, fed by the event ingest ────────
//
// The App's event loop calls pushTokenFlow() with the character count of every
// streaming delta (text/thinking/tool-input). The strip samples the running
// total on its own clock — a plain module-level accumulator, so feeding it
// costs one addition and never touches React.

const flowTotal = { chars: 0 };

export function pushTokenFlow(chars: number): void {
  if (chars > 0) flowTotal.chars += chars;
}

/** A slim canvas pulse line under the composer while streaming. Amplitude
 *  follows tokens/sec (≈ chars/4). One rAF loop, owned here; paused when the
 *  document is hidden and unmounted entirely when the turn isn't busy. */
export function TokenFlowStrip({ busy }: { busy: boolean }) {
  // Forged ONLY. The modern skin says "working" with a single ember sweep under
  // the composer (pure CSS); dropping this canvas pulse-line on top of it read
  // as a stray heart-rate monitor shoving the transcript around mid-turn.
  const forged = useUiStyle() === "new";
  const reduced = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const active = forged && busy && !reduced;

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // theme colors, read once per mount (the strip only lives for one turn)
    const styles = getComputedStyle(canvas);
    const ember = styles.getPropertyValue("--ember").trim() || "#ff6a30";
    const emberHi = styles.getPropertyValue("--ember-hi").trim() || "#ffb24d";

    const SLOTS = 160; // ring buffer of amplitude samples scrolling left
    const amps = new Float32Array(SLOTS);
    let head = 0;
    let lastChars = flowTotal.chars;
    let lastSample = performance.now();
    let ema = 0;
    let raf = 0;
    let disposed = false;

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const hgt = canvas.clientHeight;
      if (w === 0 || hgt === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(hgt * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      const mid = hgt / 2;
      const span = mid - 2;
      const phase = now / 260;
      ctx.beginPath();
      for (let i = 0; i < SLOTS; i++) {
        const a = amps[(head + i) % SLOTS]; // oldest → newest, left → right
        const x = (i / (SLOTS - 1)) * w;
        // a carrier wave whose envelope is the sampled flow rate — reads as a
        // heartbeat of the stream, flatlining when tokens stop
        const y = mid + Math.sin(phase + i * 0.42) * a * span;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.25, ember);
      grad.addColorStop(0.9, emberHi);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = ember;
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const tick = (now: number) => {
      if (disposed) return;
      const dt = now - lastSample;
      if (dt >= 66) {
        // sample flow at ~15Hz; tokens ≈ chars/4; ~70 tok/s pins the envelope
        const delta = flowTotal.chars - lastChars;
        lastChars = flowTotal.chars;
        lastSample = now;
        const tokPerSec = delta / 4 / (dt / 1000);
        const target = Math.min(1, tokPerSec / 70);
        ema += (target - ema) * 0.3;
        amps[head] = ema < 0.005 ? 0 : ema;
        head = (head + 1) % SLOTS;
      }
      draw(now);
      raf = requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (disposed) return;
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        lastChars = flowTotal.chars;
        lastSample = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!document.hidden) raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="tokenFlow" aria-hidden="true" />;
}
