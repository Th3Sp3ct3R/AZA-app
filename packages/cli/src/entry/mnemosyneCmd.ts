// `ares mnemosyne` — the CLI face of the standalone memory server.
//
// Mnemosyne shipped as a complete package in v0.38.0 and was reachable from
// nothing: no command, no import outside its own test. This is the adoption
// step the design always owed it — a way to run the server, read the bindings
// it holds, and see the compliance report that motivated the whole package
// ("recalled but violated"). It changes no existing write path: LAWS.md and
// packages/agent/src/laws.ts remain the live always-on tier until the
// single-writer migration is made deliberately.
//
// Read-only subcommands work straight off disk, so they answer whether or not
// a server is running. Mutating ones prefer a live server when one is
// listening — that is what "single writer" means — and say so when they fall
// back to writing directly.

import { request } from "node:http";
import {
  MnemosyneServer,
  MnemosyneClient,
  DEFAULT_MNEMOSYNE_PORT,
  mnemosynePaths,
  ensureToken,
  loadBindings,
  addBinding,
  retireBinding,
  alwaysOnBindings,
  activeGuards,
  complianceReport,
  type Binding,
  type BindingClass,
} from "@ares/mnemosyne";
import { notice } from "../terminalUi.js";
import { ParsedArgs, cliRuntimeContext } from "./runtime.js";

const CLASSES: BindingClass[] = ["law", "pact", "doctrine"];

function portOf(args: ParsedArgs): number {
  return Number(args.flags.get("port") ?? process.env.ARES_MNEMOSYNE_PORT ?? DEFAULT_MNEMOSYNE_PORT);
}

/** Is a server already listening? GET /health, short fuse, never throws. */
function probeHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function describe(binding: Binding): string {
  const { attested, honored, violated } = binding.stats;
  const record = attested > 0 ? ` · ${honored}✓/${violated}✗ of ${attested}` : "";
  return `[${binding.class}] ${binding.text}${record} · ${binding.id}${binding.active ? "" : " (retired)"}`;
}

async function serve(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const port = portOf(args);
  if (await probeHealth(port)) {
    process.stderr.write(`error: something is already listening on 127.0.0.1:${port}\n`);
    return 2;
  }
  const server = new MnemosyneServer({ home: context.home, port });
  const bound = await server.start();
  const paths = mnemosynePaths(context.home);
  process.stdout.write(notice("Mnemosyne", [
    `listening on ws://${bound.host}:${bound.port}`,
    `token ${paths.tokenFile}`,
    "single writer over living memory — Ctrl+C to stop",
  ], "success"));
  // Hold the process open until the operator stops it; the server owns the
  // store while it runs, so a silent exit would be worse than a loud one.
  await new Promise<void>((resolve) => {
    const stop = () => { void server.close().then(resolve, resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function connectIfServing(home: string, port: number): Promise<MnemosyneClient | null> {
  if (!(await probeHealth(port))) return null;
  try {
    const token = await ensureToken(home);
    const client = new MnemosyneClient({ url: `ws://127.0.0.1:${port}`, token, client: "ares-cli" });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

async function status(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const port = portOf(args);
  const [serving, bindings] = await Promise.all([probeHealth(port), loadBindings(context.home)]);
  const active = bindings.filter((b) => b.active);
  const report = complianceReport(active);
  const lines = [
    serving ? `server RUNNING on 127.0.0.1:${port}` : `server not running (start it with \`ares mnemosyne serve\`)`,
    `${active.length} active binding${active.length === 1 ? "" : "s"} · ${alwaysOnBindings(active).length} always-on · ${activeGuards(active).length} compiled guard(s)`,
    `${report.flagged.length} flagged as recalled-but-violated`,
    `store ${mnemosynePaths(context.home).bindingsDir}`,
  ];
  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify({ serving, port, bindings: active, flagged: report.flagged }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(notice("Mnemosyne · status", lines, serving ? "success" : "warn"));
  return 0;
}

async function list(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const all = await loadBindings(context.home);
  const bindings = args.flags.has("all") ? all : all.filter((b) => b.active);
  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(bindings, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(notice(
    "Mnemosyne · bindings",
    bindings.length > 0 ? bindings.map(describe) : ["no bindings yet"],
    bindings.length > 0 ? "success" : "warn",
  ));
  return 0;
}

async function add(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const text = args.positionals.slice(1).join(" ").trim();
  const cls = (args.flags.get("class") ?? "law") as BindingClass;
  if (!text) {
    process.stderr.write("error: ares mnemosyne add \"<the rule>\" [--class law|pact|doctrine]\n");
    return 2;
  }
  if (!CLASSES.includes(cls)) {
    process.stderr.write(`error: --class must be one of ${CLASSES.join(", ")}\n`);
    return 2;
  }
  const client = await connectIfServing(context.home, portOf(args));
  try {
    const binding = client
      ? await client.addBinding(cls, text, cls === "law" ? "owner" : "agent")
      : await addBinding(context.home, { class: cls, text, source: cls === "law" ? "owner" : "agent" });
    process.stdout.write(notice("Mnemosyne · added", [
      describe(binding),
      client ? "written through the running server" : "written directly (no server running)",
    ], "success"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

async function retire(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const id = args.positionals[1];
  if (!id) {
    process.stderr.write("error: ares mnemosyne retire <binding-id>\n");
    return 2;
  }
  const client = await connectIfServing(context.home, portOf(args));
  try {
    if (client) await client.retireBinding(id);
    else if (!(await retireBinding(context.home, id))) {
      process.stderr.write(`error: no binding with id ${id}\n`);
      return 1;
    }
    process.stdout.write(notice("Mnemosyne · retired", [id], "success"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    client?.close();
  }
}

/**
 * The report the package exists for: which bindings were recalled into the
 * prompt and then violated anyway. A rule that is remembered and broken is
 * worse than one that was never written down — it means recall is working and
 * enforcement is not.
 */
async function compliance(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const bindings = (await loadBindings(context.home)).filter((b) => b.active);
  const report = complianceReport(bindings);
  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  const attested = report.entries.filter((entry) => entry.attested > 0);
  const lines = attested.length === 0
    ? ["nothing attested yet — bindings report honored/violated once a turn attests to them"]
    : attested.map((entry) =>
        `${entry.recalledButViolated ? "FLAG" : "ok  "} ${Math.round(entry.violationRate * 100)}% violated ` +
        `(${entry.violated}/${entry.attested}) — [${entry.binding.class}] ${entry.binding.text}`);
  if (report.flagged.length > 0) {
    lines.push("", `${report.flagged.length} binding(s) recalled but violated — recall works, enforcement does not.`);
  }
  process.stdout.write(notice("Mnemosyne · compliance", lines, report.flagged.length > 0 ? "warn" : "success"));
  return 0;
}

export async function mnemosyneCommand(args: ParsedArgs): Promise<number> {
  switch (args.positionals[0] ?? "status") {
    case "serve": return serve(args);
    case "status": return status(args);
    case "bindings":
    case "list": return list(args);
    case "add": return add(args);
    case "retire": return retire(args);
    case "compliance": return compliance(args);
    default:
      process.stderr.write("usage: ares mnemosyne [status|serve|bindings|add|retire|compliance]\n");
      return 2;
  }
}
