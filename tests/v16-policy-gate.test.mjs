// Verifies the runtime permission gate (policyGate) — the wiring of the
// @ares/effects policy brain into live tool calls, with the decisive `attended`
// axis: a hard-blocked / staged action ESCALATES when the owner is present and
// is DENIED when the operator runs unattended (nobody to approve).

import test from "node:test";
import assert from "node:assert/strict";

import { gateToolPermission, classifyToolRequest, classifyShell, remoteAutonomyDecision } from "../packages/cli/dist/policyGate.js";

const req = (toolName, extra = {}) => ({ toolName, input: extra.input ?? {}, reason: extra.reason ?? "" });
const attended = (toolName, extra) => gateToolPermission(req(toolName, extra), { attended: true });
const unattended = (toolName, extra) => gateToolPermission(req(toolName, extra), { attended: false });

// ── Payment hard block ──────────────────────────────────────────────────────

test("payment (Stripe): attended escalates, unattended hard-denies", () => {
  const a = attended("Stripe", { reason: "Create a LIVE Stripe payment link" });
  assert.equal(a.kind, "ask", "owner present → ask, never auto-allow");
  assert.equal(a.hardBlocked, true);

  const u = unattended("Stripe");
  assert.equal(u.kind, "deny", "no owner → money never moves autonomously");
  assert.equal(u.hardBlocked, true);
  assert.match(u.reason, /unattended/i);
});

test("send email: hard-blocked — escalate attended, deny unattended", () => {
  assert.equal(attended("Email").kind, "ask");
  assert.equal(attended("Email").hardBlocked, true);
  assert.equal(unattended("Email").kind, "deny");
  assert.equal(unattended("Email").hardBlocked, true);
});

test("credential/secret signal in the reason is a hard block on ANY tool", () => {
  const r = req("Bash", { input: { command: "echo $OPENAI_API_KEY" }, reason: "read an api key" });
  assert.equal(classifyToolRequest(r), "credential_or_secret");
  assert.equal(gateToolPermission(r, { attended: false }).kind, "deny");
  assert.equal(gateToolPermission(r, { attended: true }).kind, "ask");
});

// ── Bash / PowerShell rails coverage ────────────────────────────────────────

test("destructive shell: escalates attended, denies unattended, not a hard block", () => {
  const cmd = { input: { command: "rm -rf build/" } };
  const a = attended("Bash", cmd);
  assert.equal(a.kind, "ask");
  assert.equal(a.hardBlocked, false);
  assert.equal(unattended("Bash", cmd).kind, "deny");
});

test("read-only shell auto-allows in both contexts", () => {
  assert.equal(attended("Bash", { input: { command: "git status" } }).kind, "allow");
  assert.equal(unattended("Bash", { input: { command: "ls -la" } }).kind, "allow");
  assert.equal(unattended("PowerShell", { input: { command: "Get-ChildItem" } }).kind, "allow");
});

test("mutating local shell flows for the unattended operator (real work)", () => {
  // recoverable/local work is exactly what a background mission must be able to do
  assert.equal(unattended("Bash", { input: { command: "npm run build && node tool.js" } }).kind, "allow");
});

test("git push is staged attended, denied unattended", () => {
  const cmd = { input: { command: "git push origin main" } };
  assert.equal(attended("Bash", cmd).kind, "ask");
  assert.equal(unattended("Bash", cmd).kind, "deny");
  assert.equal(classifyShell("git push origin main"), "git_push");
});

test("PowerShell Remove-Item classified destructive", () => {
  assert.equal(classifyShell("Remove-Item -Recurse -Force .\\dist"), "shell_destructive");
});

// ── ComputerUse / Deploy ────────────────────────────────────────────────────

test("ComputerUse drives the machine: escalate attended, deny unattended, not hard-blocked", () => {
  const a = attended("ComputerUse", { input: { action: "click", x: 10, y: 10 } });
  assert.equal(a.kind, "ask");
  assert.equal(a.hardBlocked, false);
  assert.equal(unattended("ComputerUse").kind, "deny");
});

test("Deploy is external/irreversible — staged attended, denied unattended, not blocked", () => {
  assert.equal(attended("Deploy").kind, "ask");
  assert.equal(attended("Deploy").hardBlocked, false);
  assert.equal(unattended("Deploy").kind, "deny");
});

// ── Defer (no opinion) ──────────────────────────────────────────────────────

test("benign tools get no structured opinion → defer (legacy auto decides)", () => {
  assert.equal(classifyToolRequest(req("Read")), null);
  assert.equal(attended("Read").kind, "defer");
  assert.equal(attended("Edit").kind, "defer");
});

// ── Posture: only ever stricter ─────────────────────────────────────────────

test("attended gate never DENIES (it escalates) — the owner posture is preserved", () => {
  for (const tool of ["Stripe", "Email", "Deploy", "ComputerUse"]) {
    assert.notEqual(attended(tool).kind, "deny", `${tool} attended escalates, never silently denied`);
  }
});

test("classifyShell distinguishes the three tiers", () => {
  assert.equal(classifyShell("rm -rf node_modules"), "shell_destructive");
  assert.equal(classifyShell("cat package.json"), "shell_readonly");
  assert.equal(classifyShell("git status"), "shell_readonly");
  assert.equal(classifyShell("mkdir foo && cp a b"), "shell_mutating");
});

// ── Remote autonomy posture (Telegram sessions) ─────────────────────────────
// Safe work runs without a prompt so Ares never freezes waiting on a tap; only
// money/mail/publish/credentials/wipes escalate to the owner's phone.

test("remote autonomy: safe + benign tools just RUN (no prompt)", () => {
  for (const tool of ["Read", "WebFetch", "WebSearch", "Weather", "Glob", "Grep"]) {
    assert.equal(remoteAutonomyDecision(req(tool)), "allow", `${tool} should run autonomously`);
  }
  // Desktop control, navigation, ordinary file/shell work — his machine, runs.
  assert.equal(remoteAutonomyDecision(req("ComputerUse")), "allow");
  assert.equal(remoteAutonomyDecision(req("Browser", { reason: "navigate to youtube" })), "allow");
  assert.equal(remoteAutonomyDecision(req("Bash", { input: { command: "mkdir foo" } })), "allow");
});

test("remote autonomy: the dangerous few ASK on the owner's phone", () => {
  assert.equal(remoteAutonomyDecision(req("Stripe", { reason: "create payment link" })), "ask");
  assert.equal(remoteAutonomyDecision(req("Email", { reason: "send email" })), "ask");
  assert.equal(remoteAutonomyDecision(req("Deploy", { reason: "publish to vercel" })), "ask");
  assert.equal(remoteAutonomyDecision(req("Browser", { reason: "submit checkout and pay" })), "ask");
  assert.equal(remoteAutonomyDecision(req("Bash", { input: { command: "rm -rf /" } })), "ask");
  assert.equal(remoteAutonomyDecision(req("ExitPlanMode", { reason: "approve exact durable plan" })), "ask");
  assert.equal(
    remoteAutonomyDecision(req("Bash", { input: { command: "echo $API_KEY" }, reason: "read api key" })),
    "ask",
    "credential signal always escalates",
  );
});
