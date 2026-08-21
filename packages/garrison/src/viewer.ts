// The read-only session viewer — Ares on your phone, without the keys.
//
// One self-contained HTML page served at GET /view on the garrison port. It
// speaks gateway wire protocol v1 back to the same host over WebSocket using
// the READ token (<home>/garrison/token-read), so it can list sessions, replay
// history and follow live turns — and structurally cannot send, interrupt, or
// approve anything (the server refuses those frames for read-scope clients).
//
// No frameworks, no assets, no build step: the page must work through any
// dumb tunnel (tailscale/ssh -L) that fronts the loopback port. A manifest
// data-URI makes it installable as a home-screen app.

export function viewerHtml(): string {
  return PAGE;
}

const MANIFEST = Buffer.from(
  JSON.stringify({
    name: "Ares Viewer",
    short_name: "Ares",
    display: "standalone",
    background_color: "#0a0c10",
    theme_color: "#0a0c10",
    start_url: "/view",
    icons: [],
  }),
).toString("base64");

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0c10">
<link rel="manifest" href="data:application/manifest+json;base64,${MANIFEST}">
<title>Ares — sessions</title>
<style>
:root{--bg:#0a0c10;--panel:#12161d;--line:#1f2630;--text:#dbe2ea;--dim:#7c8794;--accent:#4fd1c5;--user:#1b2735}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,sans-serif;height:100dvh;display:flex;flex-direction:column}
header{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
header b{color:var(--accent);font-size:14px;letter-spacing:.08em}
header .state{margin-left:auto;color:var(--dim);font-size:12px}
#gate{padding:24px 16px;max-width:420px;margin:0 auto;width:100%}
#gate p{color:var(--dim);margin:8px 0 16px;font-size:13px}
#gate input{width:100%;padding:12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit}
#gate button{margin-top:10px;width:100%;padding:12px;border-radius:8px;border:0;background:var(--accent);color:#06231f;font-weight:600;font-size:15px}
main{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
.hide{display:none!important}
#list .row{display:block;width:100%;text-align:left;padding:12px 14px;border:0;border-bottom:1px solid var(--line);background:none;color:var(--text);font:inherit}
#list .row small{display:block;color:var(--dim);font-size:12px}
#list .row .busy{color:var(--accent)}
#back{background:none;border:0;color:var(--accent);font:inherit;padding:4px 8px}
#chat{padding:12px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:92%;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:var(--user)}
.msg.ares{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}
.msg.tool{align-self:flex-start;color:var(--dim);font-size:12px;padding:2px 12px}
footer{padding:8px 12px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;text-align:center}
</style>
</head>
<body>
<header><b>ARES</b><span id="title"></span><span class="state" id="state">offline</span></header>
<div id="gate">
  <p>Paste the READ token from <code>~/.ares/garrison/token-read</code> on the machine running Ares. This page can watch sessions — it can never drive them.</p>
  <input id="token" type="password" placeholder="read token" autocomplete="off">
  <button id="go">Watch</button>
</div>
<main>
  <div id="list" class="hide"></div>
  <div id="chat" class="hide"></div>
</main>
<footer>read-only · the write half of the protocol is refused server-side</footer>
<script>
(function(){
  "use strict";
  var $=function(id){return document.getElementById(id)};
  var ws=null,sessions=[],current=null,liveText=null;
  var stored=localStorage.getItem("aresReadToken")||"";
  if(stored)$("token").value=stored;

  function setState(t){$("state").textContent=t}
  function connect(token){
    var proto=location.protocol==="https:"?"wss://":"ws://";
    ws=new WebSocket(proto+location.host);
    setState("connecting…");
    ws.onopen=function(){ws.send(JSON.stringify({type:"hello",token:token,client:"viewer",proto:1}))};
    ws.onclose=function(){setState("offline");setTimeout(function(){if(localStorage.getItem("aresReadToken"))connect(localStorage.getItem("aresReadToken"))},3000)};
    ws.onmessage=function(m){
      var f;try{f=JSON.parse(m.data)}catch(e){return}
      if(f.type==="welcome"){localStorage.setItem("aresReadToken",token);setState("live");$("gate").classList.add("hide");sessions=f.sessions||[];renderList()}
      else if(f.type==="error"&&!$("gate").classList.contains("hide")){setState(f.message||"rejected");localStorage.removeItem("aresReadToken")}
      else if(f.type==="sessions"){sessions=f.sessions||[];if(!current)renderList()}
      else if(f.type==="session.created"){sessions.push(f.session);if(!current)renderList()}
      else if(f.type==="session.history"&&current&&f.sessionId===current){$("chat").innerHTML="";liveText=null;(f.entries||[]).forEach(function(en){fold(en.event)})}
      else if(f.type==="event"&&current&&f.sessionId===current){fold(f.event)}
    };
  }
  function renderList(){
    $("title").textContent="";$("chat").classList.add("hide");$("list").classList.remove("hide");
    var h="";
    if(!sessions.length)h='<div class="row"><small>No sessions yet.</small></div>';
    sessions.forEach(function(s){
      h+='<button class="row" data-id="'+s.id+'"><span>'+esc(s.title||s.id)+'</span><small>'+esc(s.provider||"")+' · '+esc(s.model||"")+(s.busy?' · <span class="busy">working…</span>':"")+'</small></button>';
    });
    $("list").innerHTML=h;
    Array.prototype.forEach.call($("list").querySelectorAll(".row[data-id]"),function(b){
      b.onclick=function(){open(b.getAttribute("data-id"))};
    });
  }
  function open(id){
    current=id;liveText=null;
    var s=sessions.filter(function(x){return x.id===id})[0];
    $("title").innerHTML='<button id="back">‹ back</button> '+esc((s&&s.title)||id);
    $("back").onclick=function(){current=null;ws.send(JSON.stringify({type:"sessions.list"}));renderList()};
    $("list").classList.add("hide");$("chat").classList.remove("hide");$("chat").innerHTML='<div class="msg tool">loading history…</div>';
    ws.send(JSON.stringify({type:"session.history",sessionId:id,limit:1500}));
    ws.send(JSON.stringify({type:"session.attach",sessionId:id}));
  }
  function bubble(cls,text){
    var d=document.createElement("div");d.className="msg "+cls;d.textContent=text;
    $("chat").appendChild(d);
    $("chat").parentElement.scrollTop=$("chat").parentElement.scrollHeight;
    return d;
  }
  function msgText(m){
    if(!m)return"";
    if(typeof m.content==="string")return m.content;
    if(Array.isArray(m.content))return m.content.map(function(b){return b&&typeof b.text==="string"?b.text:""}).join("");
    return"";
  }
  function fold(e){
    if(!e||typeof e.type!=="string")return;
    if(e.type==="turn_start"){var t=msgText(e.userMessage);if(t)bubble("user",t);liveText=null}
    else if(e.type==="input_admitted"&&e.delivery==="steer"){var s=msgText(e.userMessage);if(s)bubble("user","↪ "+s)}
    else if(e.type==="text_delta"&&typeof e.text==="string"){if(!liveText)liveText=bubble("ares","");liveText.textContent+=e.text;$("chat").parentElement.scrollTop=$("chat").parentElement.scrollHeight}
    else if(e.type==="message_done"){liveText=null}
    else if(e.type==="tool_start"){bubble("tool","⚙ "+(e.activityDescription||e.name||"tool"))}
    else if(e.type==="turn_end"){liveText=null}
  }
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
  $("go").onclick=function(){var t=$("token").value.trim();if(t)connect(t)};
  $("token").addEventListener("keydown",function(ev){if(ev.key==="Enter")$("go").click()});
  if(stored)connect(stored);
})();
</script>
</body>
</html>`;
