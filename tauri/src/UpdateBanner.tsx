// Auto-update banner — checks GitHub releases for a newer signed build and lets
// the owner install it in one click. The heavy lifting (download, minisign
// signature verification, NSIS install) is the Tauri updater plugin; this is
// just the surface: check on launch + every 6h, show "a new update is
// available", and on Install download → install → relaunch (which trips the
// shell's daemon/garrison tree-kill cleanup, so nothing is orphaned).
//
// Native-only: in a plain browser (DEMO mode) the updater APIs are absent, so
// the whole component no-ops and renders nothing.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const RECHECK_MS = 6 * 60 * 60 * 1000; // every 6 hours while the app is open

type Phase = "idle" | "available" | "downloading" | "installing" | "error";

export function UpdateBanner(): React.ReactElement | null {
  const [phase, setPhase] = useState<Phase>("idle");
  const [version, setVersion] = useState<string>("");
  const [pct, setPct] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [dismissed, setDismissed] = useState<boolean>(false);
  // Hold the live Update handle between "found" and "install" so we don't
  // re-check (and re-download metadata) when the owner taps Install.
  const updateRef = useRef<Update | null>(null);

  const runCheck = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setVersion(update.version);
        setPhase("available");
        setDismissed(false);
      }
    } catch (err) {
      // A failed check is non-fatal and silent — no network, GitHub down, or no
      // release yet shouldn't nag the owner. Errors only surface once they've
      // chosen to install.
      console.warn("update check failed:", err);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void runCheck();
    const timer = window.setInterval(() => void runCheck(), RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [runCheck]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setError("");
    setPhase("downloading");
    try {
      // CRITICAL: stop the daemon + Garrison/Telegram bridge (tree-kill) BEFORE
      // the NSIS installer runs. The installer overwrites Ares.exe and the
      // bundled node.exe; if the daemon node child is still alive it locks those
      // files → "node in use" retry/ignore/abort, and the ghost then blocks the
      // new daemon from restarting. (Belt-and-suspenders: the v0.11.1 installer
      // also force-kills these in its NSIS PREINSTALL hook, which is what rescues
      // already-broken older clients on their next update.)
      try {
        await invoke("ares_stop_daemon");
      } catch (e) {
        console.warn("pre-update daemon stop failed (installer hook will still cover it):", e);
      }
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            received += event.data.chunkLength;
            setPct(total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0);
            break;
          case "Finished":
            setPhase("installing");
            break;
        }
      });
      // Install done — relaunch into the new version. The close hook reaps the
      // daemon + Garrison bridge first, so no orphaned children survive.
      await relaunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
      // We stopped the daemon above to free the files for the installer — if
      // the install/relaunch itself failed, the daemon is now permanently
      // dead until the owner manually restarts the app. Bring it back so a
      // failed update doesn't also break the app that's still running.
      try {
        await invoke("ares_start_daemon");
      } catch (restartErr) {
        console.warn("post-failure daemon restart failed:", restartErr);
      }
    }
  }, []);

  if (phase === "idle") return null;

  // "Later" must not mean invisible: a ready update collapses to a compact,
  // softly glowing chip (slow breathing ember — photosensitive-safe, nothing
  // flashes) that stays until installed. Field request: users simply never
  // realized an update existed once the banner was dismissed.
  if (dismissed && phase === "available") {
    return (
      <button
        className="updateChip"
        onClick={() => setDismissed(false)}
        title={`Update v${version} is ready — click to install`}
        aria-label={`Update v${version} ready`}
      >
        <span aria-hidden="true">⬆</span> v{version}
      </button>
    );
  }
  if (dismissed) return null;

  const busy = phase === "downloading" || phase === "installing";

  return (
    <div className="updateBanner" role="status" aria-live="polite">
      <span className="updateBanner__spark" aria-hidden="true">⬆</span>
      <div className="updateBanner__body">
        {phase === "available" && (
          <span>A new update is available{version ? ` — v${version}` : ""}.</span>
        )}
        {phase === "downloading" && <span>Downloading update… {pct}%</span>}
        {phase === "installing" && <span>Installing — Ares will relaunch…</span>}
        {phase === "error" && <span className="updateBanner__err">Update failed: {error}</span>}
      </div>
      <div className="updateBanner__actions">
        {phase === "available" && (
          <>
            <button className="updateBanner__btn updateBanner__btn--primary" onClick={() => void install()}>
              Install
            </button>
            <button className="updateBanner__btn" onClick={() => setDismissed(true)}>
              Later
            </button>
          </>
        )}
        {phase === "error" && (
          <button className="updateBanner__btn updateBanner__btn--primary" onClick={() => void install()}>
            Retry
          </button>
        )}
        {busy && (
          <div className="updateBanner__bar" aria-hidden="true">
            <div className="updateBanner__barFill" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
