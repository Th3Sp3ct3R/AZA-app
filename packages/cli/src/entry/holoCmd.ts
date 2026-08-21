import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHolotableHtml, MECH_SPEC, ROBOT_ARM_SPEC, type HoloSpec } from "../holotable.js";
import { notice } from "../terminalUi.js";
import type { ParsedArgs } from "./runtime.js";

/**
 * The Holotable is isolated from garrisonCmd. It is a pure file forge and must
 * not load providers, memory, Telegram, browser tooling, or the daemon.
 */
export async function holoCommand(args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  const out = path.resolve(args.flags.get("out") ?? "holo.html");
  let html: string;
  let what: string;
  try {
    if (target && /\.(glb|gltf)$/i.test(target)) {
      html = buildHolotableHtml({
        title: args.flags.get("title") ?? "ARES // HOLOTABLE — " + path.basename(target),
        modelUrl: target,
      });
      what = "model " + path.basename(target) + " (radial explode)";
    } else if (target && /\.json$/i.test(target)) {
      const spec = JSON.parse(await readFile(path.resolve(target), "utf8")) as HoloSpec;
      html = buildHolotableHtml({ spec, title: args.flags.get("title") });
      what = "spec \"" + spec.title + "\" — " + spec.parts.length + " parts, " +
        (spec.wires?.length ?? 0) + " wires, " + (spec.steps?.length ?? 0) + " steps";
    } else if (target === "arm") {
      html = buildHolotableHtml({ spec: ROBOT_ARM_SPEC, title: args.flags.get("title") });
      what = "the DIY robot arm build (print list, vendor list, wiring, 8 steps)";
    } else {
      html = buildHolotableHtml({ spec: MECH_SPEC, title: args.flags.get("title") });
      what = "the MK I mech showpiece";
    }
  } catch (error) {
    process.stderr.write("error: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 2;
  }
  await writeFile(out, html, "utf8");
  process.stdout.write(
    notice(
      "Holotable",
      [
        "forged " + out + " — " + what,
        "drag · rotate   slider · disassemble   ASSEMBLY MODE · step-by-step build",
        "WIRING · routed runs   PARTS/BOM · print-vs-buy + STL export",
      ],
      "success",
    ),
  );
  return 0;
}
