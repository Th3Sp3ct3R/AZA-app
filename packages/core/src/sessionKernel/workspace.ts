import path from "node:path";
import { SessionKernelStore } from "./store.js";

const workspaceStores = new Map<string, Promise<SessionKernelStore>>();

export function workspaceSessionKernelPath(workspace: string): string {
  return path.join(path.resolve(workspace), ".ares", "session-kernel.sqlite");
}

/** One WAL connection per workspace/process. Every host surface should obtain
 * its canonical session authority here instead of inventing another rollout
 * store. Failed opens are evicted so a repaired installation can retry. */
export function openWorkspaceSessionKernel(workspace: string): Promise<SessionKernelStore> {
  const filename = workspaceSessionKernelPath(workspace);
  let pending = workspaceStores.get(filename);
  if (!pending) {
    pending = SessionKernelStore.open({ filename }).catch((error) => {
      workspaceStores.delete(filename);
      throw error;
    });
    workspaceStores.set(filename, pending);
  }
  return pending;
}

