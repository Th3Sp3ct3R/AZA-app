export interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

/** Lightweight argument parsing shared by the entrypoint and command modules. */
export function parseArgs(argv: string[]): ParsedArgs {
  let command = "launcher";
  let rest = argv;
  if (argv[0] === "--help" || argv[0] === "-h") {
    command = argv[0];
    rest = argv.slice(1);
  } else if (argv[0] && !argv[0].startsWith("--")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}
