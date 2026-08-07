#!/usr/bin/env node
/**
 * Suno Session Capture — extracts a fresh Clerk bearer token from a running
 * Chrome DevTools Protocol session (port 9222) and persists it to the
 * suno-engine session file for API-based tools.
 *
 * Usage:
 *   node sunoSessionCapture.mjs              # extract & save
 *   node sunoSessionCapture.mjs --dry-run    # print token, don't save
 *   node sunoSessionCapture.mjs --output /path/to/file.json
 *
 * Requires: Chrome running with --remote-debugging-port=9222
 *           and a Suno tab logged into suno.com
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP_URL = "http://127.0.0.1:9222";
const SESSION_FILE = join(homedir(), "VAN", "suno-engine", "suno-session-persist.json");
const DRY_RUN = process.argv.includes("--dry-run");
const OUTPUT = process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1]
  : SESSION_FILE;

// ── CDP helpers ─────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDP fetch failed: ${res.status}`);
  return res.json();
}

function wsSend(ws, method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 3000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws connect error")); };
  });
}

// ── Token extraction ────────────────────────────────────────────────

async function extractClerkToken(pageWsUrl) {
  const ws = await connectWs(pageWsUrl);
  try {
    await wsSend(ws, "Runtime.enable");
    const result = await wsSend(ws, "Runtime.evaluate", {
      expression: `(() => {
        // Clerk stores the session token in __client cookie (refresh)
        // and __session cookie (access). Grab both.
        const cookies = document.cookie;
        const getCookie = (name) => {
          const match = cookies.match(new RegExp('(?:^|;\\\\s*)' + name + '=([^;]*)'));
          return match ? match[1] : null;
        };

        // Try to get Clerk token from localStorage (more reliable)
        let clerkToken = null;
        try {
          const clerkSession = localStorage.getItem('__clerk_db_jwt');
          if (clerkSession) {
            const parsed = JSON.parse(clerkSession);
            // Find the active session
            if (parsed?.sessions?.length) {
              const active = parsed.sessions.find(s => s.status === 'active') || parsed.sessions[0];
              clerkToken = active?.token || active?.last_active_token?.jwt || null;
            }
          }
        } catch {}

        // Fallback: parse __client cookie directly (it's a JWT)
        const clientCookie = getCookie('__client_Jnxw-muT') || getCookie('__client');

        return JSON.stringify({
          clerkToken,
          clientCookie,
          hasSessionCookie: !!getCookie('__session'),
          hasClientCookie: !!getCookie('__client'),
          url: location.href,
          title: document.title,
          userDisplayName: document.querySelector('[data-testid="user-menu"]')?.textContent?.trim()?.slice(0,30) || null,
        });
      })()`,
    });
    return JSON.parse(result.result.value);
  } finally {
    ws.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("[suno-capture] Connecting to Chrome CDP...");
  let tabs;
  try {
    tabs = await fetchJson(`${CDP_URL}/json`);
  } catch {
    console.error("[suno-capture] ❌ Chrome is not running on port 9222.");
    console.error("  Launch it with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-suno https://suno.com");
    process.exit(1);
  }

  const sunoTab = tabs.find(t => t.url?.includes("suno.com") && t.type === "page");
  if (!sunoTab) {
    console.error("[suno-capture] ❌ No Suno tab found. Open suno.com in the debug Chrome.");
    process.exit(1);
  }

  console.log(`[suno-capture] Found tab: ${sunoTab.title} (${sunoTab.url})`);

  let data;
  try {
    data = await extractClerkToken(sunoTab.webSocketDebuggerUrl);
  } catch (err) {
    console.error(`[suno-capture] ❌ Failed to extract token: ${err.message}`);
    process.exit(1);
  }

  if (!data.clerkToken && !data.clientCookie) {
    console.error("[suno-capture] ❌ Not signed in. Please sign into Suno in the Chrome window first.");
    process.exit(1);
  }

  console.log(`[suno-capture] ✅ Token captured (${data.clerkToken ? "Clerk JWT" : "cookie fallback"})`);
  if (data.userDisplayName) console.log(`[suno-capture]    User: ${data.userDisplayName}`);

  if (DRY_RUN) {
    console.log("[suno-capture] --dry-run: token not saved");
    console.log(`  Token: ${(data.clerkToken || data.clientCookie).slice(0, 50)}...`);
    process.exit(0);
  }

  // Merge with existing session file
  let existing = {};
  if (OUTPUT === SESSION_FILE && existsSync(SESSION_FILE)) {
    try {
      existing = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    } catch { /* start fresh */ }
  }

  const session = {
    ...existing,
    captured_at: new Date().toISOString(),
    bearer_token: data.clerkToken || existing.bearer_token || data.clientCookie,
    client_cookie: data.clientCookie || existing.client_cookie,
    clerk_active_context: existing.clerk_active_context || "",
  };

  writeFileSync(OUTPUT, JSON.stringify(session, null, 2) + "\n");
  console.log(`[suno-capture] ✅ Session saved to ${OUTPUT}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
