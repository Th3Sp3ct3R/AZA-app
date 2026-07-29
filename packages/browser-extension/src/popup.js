const $ = (id) => document.getElementById(id);
async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "popup.state" });
  $("status").textContent = state?.paired ? "Paired and ready" : state?.connected ? "Host connected — pair required" : "Native host unavailable";
  $("detail").textContent = JSON.stringify({ connected: state?.connected, paired: state?.paired, attachedTabs: state?.attachedTabs, lastError: state?.lastError }, null, 2);
  $("pause").textContent = state?.paused ? "Resume" : "Pause";
  $("visuals").textContent = state?.visualsEnabled === false ? "Effects: Off" : "Effects: On";
}
$("pair").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "popup.pair", code: $("code").value.trim() });
  if (!result?.ok) $("status").textContent = result?.error ?? "Pairing failed";
  await refresh();
});
$("pause").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "popup.pause" }); await refresh(); });
$("visuals").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "popup.visuals" }); await refresh(); });
$("detach").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "popup.detach" }); await refresh(); });
refresh();
