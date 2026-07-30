// ─── Modern skin — the Ares sigil set ────────────────────────────────────────
//
// Line-art Spartan iconography from the "Ares UI mockup revamp" design project
// (Ares HELM.dc.html). Every glyph is a single-color stroke drawing keyed to
// `currentColor`, with one crimson (#a02b1e) accent fill per icon — that pair
// is the whole signature: warm gold line, one drop of blood.
//
// The icons live in an SVG <symbol> sprite mounted once at the app root, so a
// rail of 30 medallions costs one copy of each path. <Medallion> wraps a glyph
// in the design's coin: a radial-lit disc with a gold rim.
//
// Rendered unconditionally; `.medallion` and `.aresSigil` are display:none
// outside data-style="modern" (see styles.css), so Forged/Legacy are untouched.

import React from "react";

export type SigilName =
  | "helm"
  | "new-session"
  | "sessions"
  | "artifacts"
  | "search"
  | "undo"
  | "forge"
  | "settings"
  | "voice"
  | "send"
  | "usage"
  | "messaging"
  | "skills"
  | "shield"
  | "scroll"
  | "flame";

/** The sprite. Mount once, near the top of the app tree. */
export function AresSigils(): React.ReactElement {
  return (
    <svg width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }} aria-hidden="true">
      <symbol id="ares-helm" viewBox="0 0 48 48">
        <path d="M21.6 2.5h4.8v5.4c0 1.1-1 1.9-2.4 1.9s-2.4-.8-2.4-1.9z" fill="#a02b1e" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M24 8.5c-8.4 0-14.2 6.1-14.2 14.7v7.4c0 7.1 5.7 13.2 14.2 15.9 8.5-2.7 14.2-8.8 14.2-15.9v-7.4C38.2 14.6 32.4 8.5 24 8.5Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        <path d="M12.6 19.4c2.6-4.2 6.6-6.4 11.4-6.4s8.8 2.2 11.4 6.4" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".55" />
        <path d="M14.6 22.2h7.2l-.9 5.2h-5.9zM33.4 22.2h-7.2l.9 5.2h5.9z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M22.5 22.2h3v13.4l-1.5 2-1.5-2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </symbol>
      <symbol id="ares-new-session" viewBox="0 0 48 48">
        <path d="M9.5 38.5 32 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M31 17 38.5 5.5 27 13Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M14 30.5 17.5 34" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M31 30h5v-5h4v5h5v4h-5v5h-4v-5h-5z" fill="#a02b1e" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </symbol>
      <symbol id="ares-sessions" viewBox="0 0 48 48">
        <path d="M31.5 9.5a13.5 13.5 0 1 1 0 29" fill="none" stroke="currentColor" strokeWidth="1.6" opacity=".55" />
        <circle cx="19.5" cy="24" r="13.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="19.5" cy="24" r="10" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".7" />
        <path d="M19.5 15.5 26 32h-3.6l-2.9-8-2.9 8H13z" fill="#a02b1e" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </symbol>
      <symbol id="ares-artifacts" viewBox="0 0 48 48">
        <path d="M24 5.5 41 15v18L24 42.5 7 33V15z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M7 15l17 9.5L41 15M24 24.5v18" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".8" />
        <path d="M24 10.5 30 14l-6 3.4L18 14z" fill="#a02b1e" />
        <path d="M12 22v7h5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".65" />
        <path d="M36 22v7h-5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".65" />
      </symbol>
      <symbol id="ares-search" viewBox="0 0 48 48">
        <circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="20" cy="20" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.1" opacity=".6" />
        <circle cx="20" cy="20" r="4.2" fill="none" stroke="#a02b1e" strokeWidth="2.2" />
        <path d="M29.6 29.6 41 41" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </symbol>
      <symbol id="ares-undo" viewBox="0 0 48 48">
        <path d="M14 20.5A15 15 0 1 0 29 8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M29 3 20 8.5l9 5.5z" fill="#a02b1e" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </symbol>
      <symbol id="ares-forge" viewBox="0 0 48 48">
        <path d="M8 24h20c4 0 7-2 9-5h6c0 6-4 10-9 11v5h4v5H12v-5h4v-5H8z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M20 36h8l-2-4h-4z" fill="#a02b1e" />
        <path d="M15 5l1.6 3.8L20.5 10l-3.9 1.4L15 15l-1.6-3.6L9.5 10l3.9-1.2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M31 9l1.1 2.6 2.6 1-2.6 1L31 16l-1.1-2.4-2.6-1 2.6-1z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </symbol>
      {/* The gear as drawn spans y 4.5–37.5, i.e. its optical centre is y=21 in
          a 48-unit box — 3 units high. Every other sigil centres on 24, so in a
          row of medallions this one sat visibly lifted. Nudged down to match
          rather than re-authoring the path. */}
      <symbol id="ares-settings" viewBox="0 0 48 48">
        <g transform="translate(0 3)">
          <path d="M24 4.5 30 8h7v7l3.5 6-3.5 6v7h-7l-6 3.5L18 34h-7v-7l-3.5-6L11 15V8h7z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <circle cx="24" cy="21" r="6" fill="none" stroke="#a02b1e" strokeWidth="2.4" />
        </g>
      </symbol>
      <symbol id="ares-voice" viewBox="0 0 48 48">
        <path d="M7 18h7l11-8v28l-11-8H7z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M31 16v16M37 12v24M43 19v10" stroke="#a02b1e" strokeWidth="2.6" strokeLinecap="round" />
      </symbol>
      <symbol id="ares-send" viewBox="0 0 48 48">
        <path d="M24 3 33 26l-9 6-9-6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M24 3v29" stroke="currentColor" strokeWidth="1.2" opacity=".7" />
        <path d="M24 32v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M18 34h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </symbol>
      <symbol id="ares-usage" viewBox="0 0 48 48">
        <path d="M8 6h32v28c0 6-8 8-16 10C16 42 8 40 8 34z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M15 30V21M29 30v-6M36 30v-3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M22 30V14" stroke="#a02b1e" strokeWidth="2.4" strokeLinecap="round" />
      </symbol>
      <symbol id="ares-messaging" viewBox="0 0 48 48">
        <path d="M6 11h36v22H21l-9 8v-8H6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M13 19h22M13 25h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".8" />
        <circle cx="35" cy="25" r="2.6" fill="#a02b1e" />
      </symbol>
      <symbol id="ares-skills" viewBox="0 0 48 48">
        <path d="M24 4v40" stroke="currentColor" strokeWidth="1.5" opacity=".55" />
        <path d="M24 8c-8 2-13 8-13 16s5 14 13 16" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M24 8c8 2 13 8 13 16s-5 14-13 16" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="M24 17l2.4 5.2 5.6.8-4 4 1 5.6-5-2.7-5 2.7 1-5.6-4-4 5.6-.8z" fill="#a02b1e" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </symbol>
      <symbol id="ares-shield" viewBox="0 0 48 48">
        <path d="M24 4 41 9v16c0 10-7.6 16.6-17 19-9.4-2.4-17-9-17-19V9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M24 14 31 32h-3.6L24 22.5 20.6 32H17z" fill="#a02b1e" />
      </symbol>
      <symbol id="ares-scroll" viewBox="0 0 48 48">
        <path d="M12 7h28v30c0 3-2 5-5 5H13c-3 0-5-2-5-5V12h6z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M18 16h16M18 23h16M18 30h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".8" />
      </symbol>
      <symbol id="ares-flame" viewBox="0 0 48 48">
        <path d="M24 4c2 8-6 10-6 18a6 6 0 0 0 12 0c0-3-1-5-1-5 4 3 7 7 7 12a12 12 0 0 1-24 0C12 18 22 14 24 4Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </symbol>
    </svg>
  );
}

/** A bare glyph — no coin. For inline use inside existing chrome. */
export function Sigil({ name, size = 20, className }: { name: SigilName; size?: number; className?: string }): React.ReactElement {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <use href={`#ares-${name}`} />
    </svg>
  );
}

/**
 * The design's signature control: a glyph struck into a lit coin.
 *
 * `tone` picks the rim — "gold" is the resting state used everywhere; "ember"
 * is reserved for the primary action (New session, Send) and the hero mark.
 * `size` is the coin diameter in px; the glyph scales to ~55% of it.
 */
export function Medallion({
  glyph,
  size = 38,
  tone = "gold",
  className,
}: {
  glyph: SigilName;
  size?: number;
  tone?: "gold" | "ember";
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={`medallion${className ? ` ${className}` : ""}`}
      data-tone={tone}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Sigil name={glyph} size={Math.round(size * 0.55)} />
    </span>
  );
}
