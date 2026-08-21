// Operator filesystem layout. Lives under the same immortal home as the agent
// mind (~/.ares or $ARES_HOME), in its own operator/ subtree so goals, the
// ledger (O2), and the graph (O4) survive rebuilds alongside IDENTITY/SOUL.

import path from "node:path";
import { aresAgentHome } from "@ares/agent";

export interface OperatorPaths {
  home: string;
  operatorDir: string;
  goalsDir: string;
  contractsDir: string;
  graphDir: string;
  acquisitionsDir: string;
  lessonsDir: string;
  standingDir: string;
  watchersDir: string;
}

export function operatorPaths(explicit?: string): OperatorPaths {
  const home = aresAgentHome(explicit);
  const operatorDir = path.join(home, "operator");
  return {
    home,
    operatorDir,
    goalsDir: path.join(operatorDir, "goals"),
    contractsDir: path.join(operatorDir, "contracts"),
    graphDir: path.join(operatorDir, "graph"),
    acquisitionsDir: path.join(operatorDir, "acquisitions"),
    lessonsDir: path.join(operatorDir, "lessons"),
    standingDir: path.join(operatorDir, "standing-orders"),
    watchersDir: path.join(operatorDir, "watchers"),
  };
}
