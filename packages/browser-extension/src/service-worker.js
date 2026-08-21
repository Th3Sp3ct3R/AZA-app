const HOST = "com.ares.browser_bridge";
const PROTOCOL = 1;
const MAX_BATCH = 32;
const MAX_RESULT_CHARS = 1_000_000;
const attached = new Set();
const pendingNative = new Map();
const subscriptions = new Map();
const consoleBuffers = new Map();
let port = null;
let reconnectTimer = null;
let paused = false;
let state = { connected: false, paired: false, visualsEnabled: true, lastError: null, attachedTabs: [] };

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const safeError = (error) => String(error?.message ?? error ?? "unknown error").slice(0, 2000);

async function publishState(patch = {}) {
  state = { ...state, ...patch, paused, attachedTabs: [...attached] };
  await chrome.storage.local.set({ bridgeState: state });
  await chrome.action.setBadgeText({ text: paused ? "Ⅱ" : state.paired ? "ON" : state.connected ? "…" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: paused ? "#b45309" : state.paired ? "#15803d" : "#b91c1c" });
}

function connectNative() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
    publishState({ connected: true, lastError: null });
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message ?? "native host disconnected";
      port = null;
      for (const waiter of pendingNative.values()) waiter.reject(new Error(error));
      pendingNative.clear();
      publishState({ connected: false, paired: false, lastError: error });
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectNative, 1500);
    });
    port.postMessage({ v: PROTOCOL, id: id(), type: "extension.hello", extensionId: chrome.runtime.id, at: now() });
  } catch (error) {
    publishState({ connected: false, paired: false, lastError: safeError(error) });
    reconnectTimer = setTimeout(connectNative, 2500);
  }
}

async function hmac(secret, nonce) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function onNativeMessage(message) {
  if (message?.type === "host.challenge") {
    const { pairSecret } = await chrome.storage.local.get("pairSecret");
    if (pairSecret) port?.postMessage({ v: PROTOCOL, id: id(), type: "pair.resume", nonce: message.nonce, proof: await hmac(pairSecret, message.nonce), at: now() });
    return;
  }
  if (message?.type === "pair.accepted") {
    if (message.pairSecret) await chrome.storage.local.set({ pairSecret: message.pairSecret });
    await publishState({ paired: true, lastError: null });
    if (pendingNative.has(message.id)) {
      const waiter = pendingNative.get(message.id);
      pendingNative.delete(message.id);
      waiter.resolve({ paired: true });
    }
    return;
  }
  if (message?.type === "result" && pendingNative.has(message.id)) {
    const waiter = pendingNative.get(message.id);
    pendingNative.delete(message.id);
    message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error || "request failed"));
    return;
  }
  if (message?.type === "command") {
    const response = { v: PROTOCOL, id: message.id, type: "result", at: now() };
    try {
      if (!state.paired) throw new Error("bridge is not paired");
      if (paused && !["bridge.resume", "bridge.state"].includes(message.op)) throw new Error("bridge is paused by owner");
      response.ok = true;
      response.result = await execute(message.op, message.tabId, message.params ?? {}, message.capabilities ?? []);
    } catch (error) {
      response.ok = false;
      response.error = safeError(error);
    }
    const serialized = JSON.stringify(response);
    port?.postMessage(serialized.length <= MAX_RESULT_CHARS ? response : { ...response, ok: false, result: undefined, error: "result exceeded bridge limit" });
  }
}

function nativeRequest(type, payload = {}, timeoutMs = 10_000) {
  connectNative();
  const requestId = id();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingNative.delete(requestId); reject(new Error(`${type} timed out`)); }, timeoutMs);
    pendingNative.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    port?.postMessage({ v: PROTOCOL, id: requestId, type, ...payload, at: now() });
  });
}

async function ensureAttach(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tabId is required");
  if (attached.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:|^file:/.test(tab.url ?? "")) throw new Error(`refusing protected URL: ${tab.url ?? "unknown"}`);
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  await publishState();
  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Page.enable");
  await ensureVisuals(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression, awaitPromise = true) {
  const out = await cdp(tabId, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "page evaluation failed");
  return out.result?.value;
}

const VISUAL_BOOTSTRAP = `(() => {
  if (window.__ARES_BRIDGE_VISUAL_V1__) return true;
  const host=document.createElement('div'); host.id='__ares_bridge_visual_host';
  host.style.cssText='all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict';
  const root=host.attachShadow({mode:'closed'});
  root.innerHTML=\`<style>
    :host{all:initial}.frame{position:fixed;inset:5px;border:2px solid #67e8f9;border-radius:13px;box-shadow:inset 0 0 18px #22d3ee55,0 0 16px #22d3eeaa,0 0 42px #8b5cf655;animation:aresHue 3s linear infinite;pointer-events:none}
    .status{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid #67e8f977;border-radius:999px;background:#07111ddd;color:#e6fbff;font:600 12px/1.2 system-ui,sans-serif;letter-spacing:.04em;box-shadow:0 5px 24px #0009,0 0 16px #22d3ee55;backdrop-filter:blur(10px)}
    .dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 12px #34d399;animation:aresPulse 1.3s ease-in-out infinite}
    .cursor{position:fixed;left:0;top:0;width:25px;height:25px;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 5px #000a);will-change:transform}.cursor svg{display:block}
    .ring{position:fixed;width:24px;height:24px;border:2px solid #67e8f9;border-radius:50%;transform:translate(-50%,-50%) scale(.2);animation:aresRing .55s ease-out forwards}
    .pulse{position:fixed;border:2px solid #a78bfa;border-radius:8px;box-shadow:0 0 18px #8b5cf6aa,inset 0 0 12px #22d3ee44;animation:aresTarget .42s ease-out forwards}
    @keyframes aresHue{0%{filter:hue-rotate(0)}100%{filter:hue-rotate(360deg)}} @keyframes aresPulse{50%{opacity:.35;transform:scale(.72)}}
    @keyframes aresRing{to{opacity:0;transform:translate(-50%,-50%) scale(2.4)}} @keyframes aresTarget{to{opacity:0;transform:scale(1.035)}}
    @media(prefers-reduced-motion:reduce){.frame,.dot{animation:none!important}}
  </style><div class="frame"></div><div class="status"><span class="dot"></span><span>Ares is navigating</span></div><div class="cursor"><svg width="25" height="25" viewBox="0 0 26 26"><path d="M3 2v19l5-5 4 8 4-2-4-8h8z" fill="#f8fafc" stroke="#06b6d4" stroke-width="1.7" stroke-linejoin="round"/></svg></div>\`;
  document.documentElement.appendChild(host);
  const cursor=root.querySelector('.cursor'); let x=innerWidth/2,y=innerHeight/2;
  const api={
    async moveTo(tx,ty,ms=240){const sx=x,sy=y,start=performance.now();return new Promise(resolve=>{const frame=now=>{const p=Math.min(1,(now-start)/ms),e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;x=sx+(tx-sx)*e;y=sy+(ty-sy)*e;cursor.style.transform='translate('+(x-3)+'px,'+(y-2)+'px)';p<1?requestAnimationFrame(frame):resolve()};requestAnimationFrame(frame)})},
    ripple(rx,ry){const el=document.createElement('div');el.className='ring';el.style.left=rx+'px';el.style.top=ry+'px';root.appendChild(el);setTimeout(()=>el.remove(),650)},
    pulse(rect){const el=document.createElement('div');el.className='pulse';Object.assign(el.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});root.appendChild(el);setTimeout(()=>el.remove(),520)},
    setLabel(text){root.querySelector('.status span:last-child').textContent=String(text).slice(0,80)},
    destroy(){host.remove();delete window.__ARES_BRIDGE_VISUAL_V1__}
  };
  window.__ARES_BRIDGE_VISUAL_V1__=api; return true;
})()`;

async function ensureVisuals(tabId) {
  if (!state.visualsEnabled) return;
  await evaluate(tabId, VISUAL_BOOTSTRAP).catch(() => undefined);
}

async function removeVisuals(tabId) {
  await evaluate(tabId, `window.__ARES_BRIDGE_VISUAL_V1__?.destroy?.(); true`).catch(() => undefined);
}

function selectorExpression(params) {
  const roots = `(() => { const roots=[document]; for(let i=0;i<roots.length;i++){ const root=roots[i]; for(const el of root.querySelectorAll?.('*')||[]){ if(el.shadowRoot) roots.push(el.shadowRoot); if(el.tagName==='IFRAME'){ try{ if(el.contentDocument) roots.push(el.contentDocument); }catch{} } } } return roots; })()`;
  if (params.selector) return `(${roots}.map(root => root.querySelector(${JSON.stringify(params.selector)})).find(Boolean))`;
  const name = JSON.stringify(String(params.name ?? "").toLowerCase());
  const role = JSON.stringify(String(params.role ?? "").toLowerCase());
  return `(${roots}.flatMap(root => [...root.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable=true]')]).find(el => {
    const n=(el.getAttribute('aria-label')||el.innerText||el.value||'').trim().toLowerCase();
    const r=(el.getAttribute('role')||el.tagName||'').toLowerCase();
    return n.includes(${name}) && (!${role} || r.includes(${role}));
  }))`;
}

async function elementClick(tabId, params) {
  await ensureVisuals(tabId);
  const target = selectorExpression(params);
  return evaluate(tabId, `(async () => { const el=${target}; if(!el) throw new Error('element not found'); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2; const v=window.__ARES_BRIDGE_VISUAL_V1__; v?.setLabel('Ares · clicking'); await v?.moveTo(x,y,220); v?.pulse(r); el.click(); v?.ripple(x,y); return {text:(el.innerText||el.value||el.getAttribute('aria-label')||'').slice(0,300),point:{x,y}}; })()`);
}

async function elementFill(tabId, params) {
  await ensureVisuals(tabId);
  const target = selectorExpression(params);
  const value = JSON.stringify(String(params.value ?? ""));
  return evaluate(tabId, `(async () => { const el=${target}; if(!el) throw new Error('element not found'); el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,v=window.__ARES_BRIDGE_VISUAL_V1__;v?.setLabel('Ares · typing');await v?.moveTo(x,y,220);v?.pulse(r);el.focus();const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;setter?setter.call(el,${value}):el.value=${value};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {value:String(el.value??'').slice(0,1000)};})()`);
}

async function snapshot(tabId) {
  return evaluate(tabId, `(() => ({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,20000),controls:[...document.querySelectorAll('button,a,input,textarea,select,[role],[contenteditable=true]')].slice(0,300).map((el,i)=>({i,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||'',name:(el.getAttribute('aria-label')||el.innerText||el.value||'').trim().slice(0,300),disabled:!!el.disabled}))}))()`);
}

async function waitTabComplete(tabId, timeoutMs = 15_000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("navigation did not settle")); }, timeoutMs);
    const listener = (changedId, info, tab) => {
      if (changedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function execute(op, tabId, params, capabilities) {
  const requireCapability = (name) => { if (!capabilities.includes(name) && !capabilities.includes("*")) throw new Error(`missing capability: ${name}`); };
  if (op === "bridge.state") return state;
  if (op === "bridge.pause") { paused = true; await publishState(); return state; }
  if (op === "bridge.resume") { paused = false; await publishState(); return state; }
  if (op === "bridge.detachAll") { for (const id of [...attached]) { await removeVisuals(id); await chrome.debugger.detach({ tabId: id }).catch(() => {}); } attached.clear(); await publishState(); return state; }
  if (op === "tabs.list") return chrome.tabs.query({});
  if (op === "tab.activate") { await chrome.tabs.update(tabId, { active: true }); return chrome.tabs.get(tabId); }
  if (op === "tab.attach") { await ensureAttach(tabId); return chrome.tabs.get(tabId); }
  if (op === "tab.detach") { await removeVisuals(tabId); await chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); await publishState(); return true; }
  requireCapability("observe");
  if (op === "page.state") return chrome.tabs.get(tabId);
  if (op === "page.screenshot") return cdp(tabId, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  if (op === "dom.snapshot") return snapshot(tabId);
  if (op === "ax.snapshot") return cdp(tabId, "Accessibility.getFullAXTree", { depth: params.depth ?? 8 });
  if (op === "console.enable") { subscriptions.set(tabId, { ...(subscriptions.get(tabId) ?? {}), console: true }); await cdp(tabId, "Runtime.enable"); return true; }
  if (op === "console.read") return (consoleBuffers.get(tabId) ?? []).slice(-(params.limit ?? 100));
  if (op === "network.enable") { subscriptions.set(tabId, { ...(subscriptions.get(tabId) ?? {}), network: true }); await cdp(tabId, "Network.enable", { maxTotalBufferSize: 10_000_000 }); return true; }
  if (op === "runtime.evaluate") { requireCapability("debug"); return evaluate(tabId, String(params.expression ?? "undefined")); }
  requireCapability("interact");
  if (op === "page.navigate") {
    const url = String(params.url ?? "");
    if (!/^https?:\/\//.test(url) && !/^file:\/\//.test(url)) throw new Error("unsupported navigation URL");
    await cdp(tabId, "Page.navigate", { url });
    const tab = await waitTabComplete(tabId, params.timeoutMs ?? 15_000);
    await ensureVisuals(tabId);
    return tab;
  }
  if (op === "element.click") return elementClick(tabId, params);
  if (op === "element.fill") return elementFill(tabId, params);
  if (op === "element.press") {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: params.key, code: params.code ?? params.key });
    return cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: params.key, code: params.code ?? params.key });
  }
  if (op === "act.batch") {
    if (!Array.isArray(params.steps) || params.steps.length < 1 || params.steps.length > MAX_BATCH) throw new Error(`batch must have 1-${MAX_BATCH} steps`);
    const completed = [];
    for (let index = 0; index < params.steps.length; index++) {
      const step = params.steps[index];
      completed.push({ index, op: step.op, result: await execute(step.op, step.tabId ?? tabId, step.params ?? {}, capabilities) });
    }
    const [observed, screenshot] = await Promise.all([snapshot(tabId), execute("page.screenshot", tabId, {}, ["observe"])]);
    return { completed, observed, screenshot };
  }
  throw new Error(`unsupported operation: ${op}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "popup.state") { sendResponse(state); return false; }
  if (message?.type === "popup.pair") {
    nativeRequest("pair.request", { code: String(message.code ?? "") }).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }
  if (message?.type === "popup.pause") { paused = !paused; publishState().then(() => sendResponse({ ok: true, state })); return true; }
  if (message?.type === "popup.visuals") {
    state.visualsEnabled = !state.visualsEnabled;
    Promise.all([...attached].map((tabId) => state.visualsEnabled ? ensureVisuals(tabId) : removeVisuals(tabId)))
      .then(() => publishState()).then(() => sendResponse({ ok: true, state }));
    return true;
  }
  if (message?.type === "popup.detach") { execute("bridge.detachAll", null, {}, ["*"]).then(() => sendResponse({ ok: true })); return true; }
  return false;
});

chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); publishState(); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const wanted = subscriptions.get(tabId) ?? {};
  if ((method.startsWith("Runtime.") && wanted.console) || (method.startsWith("Network.") && wanted.network)) {
    if (method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
      const list = consoleBuffers.get(tabId) ?? [];
      list.push({ method, params, at: now() });
      if (list.length > 500) list.shift();
      consoleBuffers.set(tabId, list);
    }
    port?.postMessage({ v: PROTOCOL, id: id(), type: "event", tabId, method, params, at: now() });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); publishState(); });
chrome.runtime.onInstalled.addListener(connectNative);
chrome.runtime.onStartup.addListener(connectNative);
chrome.storage.local.get("bridgeState").then(({ bridgeState }) => {
  if (typeof bridgeState?.visualsEnabled === "boolean") state.visualsEnabled = bridgeState.visualsEnabled;
  return publishState();
}).finally(connectNative);
