// Why the Garrison died, in words a coworker can act on.
//
// Field origin: external users started reporting
//
//   The Garrison went down (exit code 134).
//   16: 00007FF63158B1EC AES_cbc_encrypt+152028
//   17: 00007FF63314C5A4 inflateValidate+40756
//   18: 00007FFFE704E957 BaseThreadInitThunk+23
//   19: 00007FFFE7A6AD6C RtlUserThreadStart+44
//
// …which is four lines of nothing. The desktop showed the LAST four stderr
// lines, and the last four lines of a V8 fatal dump are always the bottom of
// the stack — addresses resolved against whatever exported symbol happens to
// sit nearest in node.exe (`AES_cbc_encrypt`, `inflateValidate`: neither has
// anything to do with the crash). The one line that says what happened —
// `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of
// memory` — is at the TOP of that dump and got scrolled off.
//
// So: pick the lines that carry information, drop the frame noise, and name
// the cause. Exit 134 is SIGABRT — for a Node process that is overwhelmingly
// V8 aborting on the heap limit, which is also why it correlates with "the
// longer I use it the slower it gets".
//
// Pure and dependency-free: the desktop imports it from source, the daemon
// and the tests import it from dist.

export type DaemonExitCause = "oom" | "abort" | "crash" | "clean" | "unknown";

export interface DaemonExitExplanation {
  /** One sentence naming what happened. */
  headline: string;
  /** The informative stderr lines, frame noise removed. May be empty. */
  detail: string;
  cause: DaemonExitCause;
  /** What the person in front of the screen can do about it. */
  advice: string;
}

/** A resolved stack frame from a V8/Node fatal dump: `12: 00007FF6… foo+1234`. */
const FRAME_LINE = /^\s*\d+:\s*(0x)?[0-9A-Fa-f]{6,}\b/;
/** V8's register/segment dumps and other pure-hex spew. */
const HEX_NOISE = /^[\s0-9A-Fa-f:+x,-]+$/;

const SIGNAL_LINES: RegExp[] = [
  /FATAL ERROR/i,
  /JavaScript heap out of memory/i,
  /Allocation failed/i,
  /Reached heap limit/i,
  /out of memory/i,
  /Assertion.*failed/i,
  /^\s*(Uncaught|Unhandled)/i,
  /\bError\b:/,
  /^error:/i,
];

const OOM_MARKERS = /heap out of memory|Reached heap limit|Allocation failed|ERR_WORKER_OUT_OF_MEMORY|bad_alloc/i;

/** Windows fast-fail / structured-exception codes worth naming. */
const WINDOWS_FATAL: Record<number, string> = {
  3221225477: "access violation (0xC0000005)",
  3221225725: "stack overflow (0xC00000FD)",
  3221226505: "runtime fast-fail (0xC0000409)",
};

function isNoise(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (FRAME_LINE.test(trimmed)) return true;
  if (trimmed.length > 8 && HEX_NOISE.test(trimmed)) return true;
  // V8 prints these around the fatal line; they add nothing for a reader.
  return /^(Security context:|==== JS stack trace|-{4,}|Native stack trace)/i.test(trimmed);
}

/**
 * Choose what to show under "the Garrison went down".
 *
 * Preference order: lines that state a cause, then the most recent non-noise
 * lines, then — only if there is genuinely nothing else — the raw tail, so a
 * crash we have no pattern for still shows *something*.
 */
export function meaningfulStderr(stderrTail: readonly string[], max = 4): string[] {
  const lines = stderrTail.map((line) => line.replace(/\s+$/, "")).filter((line) => line.trim());
  const signal = lines.filter((line) => SIGNAL_LINES.some((re) => re.test(line)));
  if (signal.length) return signal.slice(-max);
  const informative = lines.filter((line) => !isNoise(line));
  if (informative.length) return informative.slice(-max);
  return lines.slice(-max);
}

export function explainDaemonExit(
  code: number | null | undefined,
  stderrTail: readonly string[] = [],
): DaemonExitExplanation {
  const detailLines = meaningfulStderr(stderrTail);
  const detail = detailLines.join("\n");
  const blob = stderrTail.join("\n");
  const oomInStderr = OOM_MARKERS.test(blob);

  // 134 = 128 + SIGABRT. Node aborts for exactly two reasons in the wild: the
  // V8 heap limit, and an internal assertion. Absent an assertion line, say
  // memory — that is what it is nearly every time, and guessing "unknown"
  // helps nobody.
  if (code === 134 || code === 6 || oomInStderr) {
    const assertion = /Assertion.*failed/i.test(blob) && !oomInStderr;
    if (assertion) {
      return {
        headline: "The Garrison hit an internal assertion and aborted (exit 134).",
        detail,
        cause: "abort",
        advice: "Your sessions are on disk and it restarts automatically. If it repeats, send the crash log from ~/.ares/crashes.",
      };
    }
    return {
      headline: "The Garrison ran out of memory and was killed by its own runtime (exit 134).",
      detail,
      cause: "oom",
      advice:
        "Nothing was lost — sessions live on disk and it restarts itself. Memory climbs with the number of sessions kept open at once, so if this keeps happening, restart Ares and keep fewer sessions active.",
    };
  }

  if (code === 0 || code === null || code === undefined) {
    return {
      headline: code === 0 ? "The Garrison stopped cleanly." : "The Garrison stopped.",
      detail,
      cause: code === 0 ? "clean" : "unknown",
      advice: "Restarting it is safe — your sessions are on disk.",
    };
  }

  const windows = WINDOWS_FATAL[code];
  if (windows) {
    return {
      headline: `The Garrison crashed — ${windows}.`,
      detail,
      cause: "crash",
      advice: "It restarts automatically. If it repeats, send the crash log from ~/.ares/crashes.",
    };
  }

  // 128+N — killed by a signal (137 = OOM-killer on Linux, 143 = SIGTERM).
  if (code === 137) {
    return {
      headline: "The Garrison was killed by the operating system for using too much memory (exit 137).",
      detail,
      cause: "oom",
      advice:
        "The machine, not Ares, made this call. Close other heavy apps or keep fewer Ares sessions open, then restart.",
    };
  }
  if (code === 143 || code === 130) {
    return {
      headline: "The Garrison was asked to stop and did (exit " + code + ").",
      detail,
      cause: "clean",
      advice: "Restarting it is safe — your sessions are on disk.",
    };
  }

  return {
    headline: `The Garrison went down (exit code ${code}).`,
    detail,
    cause: "crash",
    advice: "It restarts automatically. If it repeats, send the crash log from ~/.ares/crashes.",
  };
}

/** The whole message the desktop shows, assembled in one place. */
export function daemonExitMessage(
  code: number | null | undefined,
  stderrTail: readonly string[],
  restart?: { willRetry: boolean; attempt: number; max: number },
): string {
  const { headline, detail, advice } = explainDaemonExit(code, stderrTail);
  const parts = [headline];
  if (detail) parts.push(detail);
  if (advice) parts.push(advice);
  if (restart) {
    parts.push(
      restart.willRetry
        ? `Restarting… (attempt ${restart.attempt}/${restart.max})`
        : "Auto-restart limit reached — use Restart in the status bar.",
    );
  }
  return parts.join("\n");
}
