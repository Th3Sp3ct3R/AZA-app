// Stream stall watchdog — shared by every streaming provider.
//
// A hung connection used to freeze a turn forever: reader.read() blocks
// indefinitely and nothing ever aborts it ("it froze on an edit"). The guard
// aborts the in-flight fetch when no bytes arrive for ARES_STREAM_STALL_MS
// (default 180s) so the engine surfaces a retriable error instead of an
// eternal hang.

import type { StreamEvent } from "@ares/protocol";

export interface StallGuard {
  /** Pass this to fetch() so a stall abort actually cancels the read. */
  signal: AbortSignal;
  /** Call after every received chunk to push the deadline forward. */
  reset(): void;
  /** True when the most recent abort came from the watchdog, not the caller. */
  stalled(): boolean;
  /** Clear the timer (normal completion or hand-off to error paths). */
  dispose(): void;
}

export function createStallGuard(
  outer: AbortSignal | undefined,
  ms: number = streamStallMs(),
): StallGuard {
  const controller = new AbortController();
  let stalled = false;
  const fire = () => {
    stalled = true;
    controller.abort();
  };
  const arm = (): ReturnType<typeof setTimeout> => {
    const t = setTimeout(fire, ms);
    // Never let a watchdog timer keep the process alive after a stream ends.
    (t as { unref?: () => void }).unref?.();
    return t;
  };
  let timer = arm();
  const onOuter = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      if (!controller.signal.aborted) timer = arm();
    },
    stalled: () => stalled,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export function streamStallMs(): number {
  const raw = Number(process.env.ARES_STREAM_STALL_MS);
  if (Number.isFinite(raw) && raw >= 5_000) return Math.floor(raw);
  return 180_000;
}

export function stallErrorEvent(): StreamEvent {
  return {
    type: "error",
    error: {
      // "stream_stall" — NOT "stream_stalled" — because that exact code is what
      // isStallError / frictionLog / reliabilityTriage match. The old "-ed"
      // spelling made provider-level stalls invisible to the shrink ladder, so
      // an oversized prompt was re-sent at the same size four more times.
      code: "stream_stall",
      message: `provider stream stalled — no data received for ${Math.round(streamStallMs() / 1000)}s. The connection or model hung; retrying is safe.`,
      retriable: true,
    },
  };
}
