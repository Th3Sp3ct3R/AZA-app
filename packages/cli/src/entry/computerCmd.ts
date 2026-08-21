// `ares computer` — manage the agent's own computer (the WSL2 Debian sandbox).
//
//   ares computer status     availability, provisioning, leases
//   ares computer setup      first-time provision (rootfs download + packages)
//   ares computer wake [task] boot the desktop, stamp the task, print the boot report
//   ares computer screen     start the watchable noVNC screen, print its URL
//   ares computer screen-off stop streaming (desktop keeps running)
//   ares computer exec -- …  run a command inside the sandbox
//   ares computer snapshot   full-image export tar
//   ares computer rebuild    fresh OS, same home, manifest replayed

import { getAgentComputer } from "@ares/tools";
import { loadUiSettings, updateUiSettings } from "../uiSettings.js";
import type { ParsedArgs } from "./args.js";

export async function computerCommand(parsed: ParsedArgs): Promise<number> {
  const args = parsed.positionals;
  const action = args[0] ?? "status";
  const box = getAgentComputer();
  try {
    if (action === "status") {
      const status = await box.status();
      console.log(JSON.stringify(status, null, 2));
      if (status.blocked === "vm-platform") {
        console.log(
          "\nWSL2 cannot start VMs on this PC. One-time fix (admin + reboot):\n  wsl.exe --install --no-distribution",
        );
      } else if (!status.provisioned) {
        console.log("\nNot set up yet — run: ares computer setup");
      }
      return 0;
    }
    if (action === "setup") {
      const result = await box.setup((line) => console.log(`[setup] ${line}`));
      console.log(result);
      return 0;
    }
    if (action === "screen") {
      const viewOnly = args.includes("--watch") || parsed.flags.has("watch");
      const screen = await box.ensureScreen(1, viewOnly);
      console.log(screen.url);
      return 0;
    }
    if (action === "exec") {
      const split = args.indexOf("--");
      const command = (split >= 0 ? args.slice(split + 1) : args.slice(1)).join(" ");
      if (!command) {
        console.error("usage: ares computer exec -- <command>");
        return 2;
      }
      const result = await box.exec(command, { timeoutMs: 300_000 });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.exitCode;
    }
    if (action === "distros") {
      const distros = await box.listDistros();
      const current = await box.distroName();
      for (const name of distros) console.log(`${name === current ? "*" : " "} ${name}`);
      if (distros.length === 0) console.log("(no WSL distros registered)");
      return 0;
    }
    if (action === "use") {
      const name = args[1];
      if (!name) {
        console.error("usage: ares computer use <distro>   (see: ares computer distros)");
        return 2;
      }
      console.log(await box.adoptDistro(name));
      return 0;
    }
    if (action === "mode") {
      const wanted = args[1];
      if (wanted !== "host" && wanted !== "sandbox") {
        const current = (await loadUiSettings().catch(() => null))?.computerMode ?? "host";
        console.log(`computer mode: ${current}`);
        console.log("usage: ares computer mode <host|sandbox>");
        return wanted === undefined ? 0 : 2;
      }
      await updateUiSettings({ computerMode: wanted });
      console.log(
        wanted === "sandbox"
          ? "Sandbox only — Ares works on its own computer; host shells, GUI control and file writes are withheld."
          : "Host mode — Ares can work on your machine (gated as usual) and on its own computer when asked.",
      );
      return 0;
    }
    if (action === "snapshot") {
      console.log(await box.snapshot());
      return 0;
    }
    if (action === "rebuild") {
      console.log(await box.rebuild((line) => console.log(`[rebuild] ${line}`)));
      return 0;
    }
    if (action === "wake") {
      // The arrival ritual: boot the desktop, stamp the wallpaper, print the
      // boot report (uptime, disk, last deeds, MACHINE.md).
      console.log(await box.wake(args.slice(1).join(" ") || undefined));
      return 0;
    }
    if (action === "screen-off") {
      console.log(await box.screenOff(1));
      return 0;
    }
    console.error(
      "usage: ares computer <status|setup|wake [task]|screen [--watch]|screen-off|exec -- cmd|distros|use <distro>|mode <host|sandbox>|snapshot|rebuild>",
    );
    return 2;
  } catch (error) {
    console.error((error instanceof Error ? error.message : String(error)).replace(/<\/?tool_use_error>/g, ""));
    return 1;
  }
}
