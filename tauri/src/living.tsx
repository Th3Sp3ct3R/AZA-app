import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { LivingSurface } from "./LivingSurface";
import "./livingSurface.css";

class LivingErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Living Surface renderer crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="livingFatal">
          <span>SURFACE INTERRUPTED</span>
          <h1>The experiment hit a rendering fault.</h1>
          <p>{this.state.error.message || "An unknown renderer error occurred."}</p>
          <button onClick={() => window.location.reload()}>RESTART SURFACE</button>
        </main>
      );
    }
    return this.props.children;
  }
}

window.addEventListener("error", (event) => {
  console.error("Living Surface unhandled error:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("Living Surface unhandled rejection:", event.reason);
});

const root = document.getElementById("root");

async function mountLivingSurface() {
  if (!root) return;
  const match = window.location.hash.match(/^#(?:session|living)\/([a-z0-9_-]+)$/i);
  let sessionId = match?.[1] ?? "";
  if (!sessionId) {
    try {
      sessionId = await invoke<string>("ares_living_surface_context");
    } catch (error) {
      root.innerHTML = `<main class="livingFatal"><span>SURFACE BOOT FAILED</span><h1>Ares could not initialize this experiment.</h1><p>${String(error).replace(/[<>&]/g, "")}</p><button onclick="location.reload()">RETRY</button></main>`;
      return;
    }
  }
  createRoot(root).render(
      <LivingErrorBoundary>
        <LivingSurface sessionId={sessionId} />
      </LivingErrorBoundary>,
    );
}

void mountLivingSurface();
