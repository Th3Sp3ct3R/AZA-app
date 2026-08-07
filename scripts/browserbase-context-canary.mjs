// Browserbase Context persistence + BYO-proxy canary (P0 go/no-go).
//
// Proves the two things we must trust before building a Browserbase adapter in
// @ares/connectors:
//   1. A Browserbase *Context* (persistent profile) survives a session restart —
//      cookies + localStorage written in session #1 are still present in a fresh
//      session #2 that reuses the same contextId. This is the hosted equivalent
//      of Playwright's launchPersistentContext(userDataDir).
//   2. A *bring-your-own* proxy actually routes egress — the IP the page sees is
//      the BYO proxy's, NOT a Browserbase datacenter IP. (Our IG accounts need
//      geo-matched mobile proxies; Browserbase's built-in pool won't do.)
//
// It talks to the Browserbase REST API with plain fetch (Node 22 global) and
// drives sessions over CDP with Playwright (already an optionalDependency of
// @ares/connectors). No new dependencies, no SDK.
//
// Run:
//   BROWSERBASE_API_KEY=bb_...  BROWSERBASE_PROJECT_ID=...  \
//   BROWSERBASE_PROXY=http://user:pass@host:port  \
//   node scripts/browserbase-context-canary.mjs
//
// BROWSERBASE_PROXY is optional: omit it to test Context persistence alone
// (egress will be a Browserbase datacenter IP). Provide it to also validate the
// BYO-proxy path — pass the same NL mobile proxy the IG login path uses.

const API = "https://api.browserbase.com/v1";
const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const PROXY = process.env.BROWSERBASE_PROXY; // http://user:pass@host:port (optional)

// A stable, low-noise origin to write our persistence marker on.
const MARKER_ORIGIN = "https://example.com/";
const IP_ECHO = "https://api.ipify.org/?format=json";

function die(msg) {
  console.error(`\n❌  ${msg}\n`);
  process.exit(1);
}

if (!API_KEY || !PROJECT_ID) {
  die(
    "Missing credentials. Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.\n" +
      "   Get them at https://www.browserbase.com/sign-up → Settings → API Keys.\n" +
      "   Then re-run:\n" +
      "     BROWSERBASE_API_KEY=bb_... BROWSERBASE_PROJECT_ID=... \\\n" +
      "     BROWSERBASE_PROXY=http://user:pass@host:port \\\n" +
      "     node scripts/browserbase-context-canary.mjs",
  );
}

// ── Playwright is an optionalDependency of @ares/connectors; import it the same
// way the real engine (playwrightBrowser.ts) does, and guide install if absent.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  die(
    "Playwright not installed. From the repo root:\n" +
      "     pnpm add -w playwright && npx playwright install chromium",
  );
}

async function bb(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      "X-BB-API-Key": API_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Browserbase ${init.method || "GET"} ${pathname} → ${res.status}: ${text}`);
  }
  return body;
}

/** Parse http://user:pass@host:port into Browserbase's external-proxy shape. */
function parseProxy(url) {
  if (!url) return undefined;
  const u = new URL(url);
  const server = `${u.protocol}//${u.hostname}:${u.port}`;
  const proxy = { type: "external", server };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return [proxy];
}

async function createSession(contextId) {
  const browserSettings = { context: { id: contextId, persist: true } };
  const proxies = parseProxy(PROXY);
  const body = { projectId: PROJECT_ID, browserSettings };
  if (proxies) body.proxies = proxies;
  return bb("/sessions", { method: "POST", body: JSON.stringify(body) });
}

async function releaseSession(id) {
  // persist:true saves context changes back on release. Best-effort.
  try {
    await bb(`/sessions/${id}`, {
      method: "POST",
      body: JSON.stringify({ projectId: PROJECT_ID, status: "REQUEST_RELEASE" }),
    });
  } catch (err) {
    console.warn(`   (release ${id} failed, non-fatal: ${err.message})`);
  }
}

/** Connect over CDP, run fn(page), always disconnect. Returns fn's result. */
async function withSession(connectUrl, fn) {
  const browser = await chromium.connectOverCDP(connectUrl);
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    return await fn(page, ctx);
  } finally {
    await browser.close();
  }
}

async function readEgressIp(page) {
  try {
    await page.goto(IP_ECHO, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const txt = await page.evaluate(() => document.body?.innerText ?? "");
    return JSON.parse(txt).ip;
  } catch {
    return "(could not read egress IP)";
  }
}

const MARKER = `canary-${PROJECT_ID.slice(0, 6)}-${process.pid}`;

console.log("\n── Browserbase Context canary ──────────────────");
console.log(`   project   : ${PROJECT_ID}`);
console.log(`   proxy     : ${PROXY ? new URL(PROXY).host + " (BYO)" : "(none — Browserbase egress)"}`);
console.log(`   marker    : ${MARKER}`);

let contextId;
let ip1;
let ip2;

try {
  // 1. Create a persistent Context.
  const context = await bb("/contexts", {
    method: "POST",
    body: JSON.stringify({ projectId: PROJECT_ID }),
  });
  contextId = context.id;
  console.log(`\n①  created context ${contextId}`);

  // 2. Session #1 — write the marker (cookie + localStorage) on MARKER_ORIGIN.
  const s1 = await createSession(contextId);
  console.log(`②  session #1 ${s1.id} — writing marker`);
  ip1 = await withSession(s1.connectUrl, async (page) => {
    const egress = await readEgressIp(page);
    await page.goto(MARKER_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate((m) => {
      document.cookie = `bb_canary=${m}; path=/; max-age=86400; samesite=lax`;
      localStorage.setItem("bb_canary", m);
    }, MARKER);
    return egress;
  });
  await releaseSession(s1.id);
  console.log(`   egress IP (session #1): ${ip1}`);

  // Give Browserbase a moment to persist context state on release.
  await new Promise((r) => setTimeout(r, 4000));

  // 3. Session #2 — SAME contextId, fresh browser. Read the marker back.
  const s2 = await createSession(contextId);
  console.log(`③  session #2 ${s2.id} — reading marker (fresh browser, same context)`);
  const found = await withSession(s2.connectUrl, async (page) => {
    ip2 = await readEgressIp(page);
    await page.goto(MARKER_ORIGIN, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page.evaluate(() => {
      const cookie = (document.cookie.match(/bb_canary=([^;]+)/) || [])[1] || null;
      const ls = localStorage.getItem("bb_canary");
      return { cookie, ls };
    });
  });
  await releaseSession(s2.id);
  console.log(`   egress IP (session #2): ${ip2}`);

  // 4. Verdict.
  const cookieOk = found.cookie === MARKER;
  const lsOk = found.ls === MARKER;
  console.log("\n── Results ──────────────────────────");
  console.log(`   cookie persisted        : ${cookieOk ? "✅ yes" : `❌ no (got ${found.cookie})`}`);
  console.log(`   localStorage persisted  : ${lsOk ? "✅ yes" : `❌ no (got ${found.ls})`}`);
  if (PROXY) {
    const proxyHost = new URL(PROXY).hostname;
    console.log(`   BYO proxy egress        : session IPs = ${ip1} / ${ip2}`);
    console.log(`                             (confirm these are ${proxyHost}'s exit, not a datacenter IP)`);
  }

  const pass = cookieOk; // cookie persistence is the hard gate; localStorage is a bonus
  console.log(`\n   VERDICT: ${pass ? "✅ PASS — Context persistence works. Proceed to adapter (P1)." : "❌ FAIL — do NOT build on Browserbase Contexts yet."}\n`);
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`\n❌  canary error: ${err.message}\n`);
  process.exit(1);
} finally {
  if (contextId) console.log(`   (context ${contextId} left intact for inspection)`);
}
